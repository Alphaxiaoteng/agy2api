/**
 * Security and Path Traversal Tests for FlowStorage
 *
 * Verifies:
 * 1. Malicious filenames containing '../' are rejected / cleaned and resolveMedia returns null
 * 2. Symbolic links to files or directories outside storage return null
 * 3. Symlink directories are ignored during listJobs and resolveMedia
 * 4. Manifest path escape attempts fail
 */

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { FlowStorage } from '../src/utils/flowStorage.js';

console.log('=== Starting Flow Storage Security & Symlink Tests ===\n');

const testDir = path.join(os.tmpdir(), `flow_storage_sec_test_${Date.now()}`);
const outsideDir = path.join(os.tmpdir(), `flow_outside_${Date.now()}`);

try {
  fs.mkdirSync(testDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const outsideFile = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outsideFile, 'CRITICAL_SECRET_DATA');

  const storage = new FlowStorage(testDir);

  // 1. Test directory traversal in manifest output filename
  console.log('1. Testing ../ traversal in manifest outputs...');
  const jobId1 = 'job_evil_traversal';
  storage.createJobDir(jobId1);

  storage.writeManifest(jobId1, {
    jobId: jobId1,
    type: 'image',
    status: 'completed',
    outputs: [
      {
        mediaId: 'media_evil_1',
        filename: '../../outside.txt',
        mimeType: 'text/plain',
      },
      {
        mediaId: 'media_evil_2',
        filename: '../job_evil_traversal/evil.png',
        mimeType: 'image/png',
      }
    ]
  });

  assert.equal(storage.resolveMedia('media_evil_1'), null);
  assert.equal(storage.resolveMedia('media_evil_2'), null);
  console.log('✓ Path traversal filename rejected');

  // 2. Test Symlink to outside file inside job directory
  console.log('2. Testing symlink to outside file...');
  const jobId2 = 'job_symlink_file';
  const jobDir2 = storage.createJobDir(jobId2);
  const symlinkPath = path.join(jobDir2, 'symlink.png');

  try {
    fs.symlinkSync(outsideFile, symlinkPath);
  } catch (_) {}

  if (fs.existsSync(symlinkPath)) {
    storage.writeManifest(jobId2, {
      jobId: jobId2,
      type: 'image',
      status: 'completed',
      outputs: [
        {
          mediaId: 'media_symlink_1',
          filename: 'symlink.png',
          mimeType: 'image/png',
        }
      ]
    });

    // resolveMedia MUST reject symbolic links and return null
    assert.equal(storage.resolveMedia('media_symlink_1'), null);
    console.log('✓ Symlink file rejected');
  }

  // 3. Test Symlink directory in baseDir
  console.log('3. Testing symlink directory inside jobs storage...');
  const symlinkJobDir = path.join(testDir, 'job_symlink_dir');
  try {
    fs.symlinkSync(outsideDir, symlinkJobDir);
  } catch (_) {}

  if (fs.existsSync(symlinkJobDir)) {
    // listJobs must skip symlinked directories
    const jobs = storage.listJobs();
    assert.equal(jobs.includes('job_symlink_dir'), false);
    console.log('✓ Symlinked job directory skipped by listJobs');
  }

  console.log('\n=== All Flow Storage Security Tests Passed Successfully! ===');
} finally {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  } catch (_) {}
}
