/**
 * Unified Test Runner for Flow API, CLI, Extension Bridge, Storage Security and Recovery
 *
 * Runs all Flow tests and CLI integration tests in sequence.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const testFiles = [
  'test/test-cursor-gemini-routing.js',
  'test/test-flow-protocol.js',
  'test/test-flow-extension-files.js',
  'test/test-flow-extension-bridge.js',
  'test/test-flow-extension-security.js',
  'test/test-flow-ws-coexistence.js',
  'test/test-flow-storage-security.js',
  'test/test-flow-recovery.js',
  'test/test-flow-api-worker.js',
  'test/test-flow-api.js',
  'test/test-flow-cli.js',
  'test/test-flow-multi-account.js',
];

async function runTest(file) {
  return new Promise((resolve, reject) => {
    console.log(`\n======================================================`);
    console.log(`RUNNING: ${file}`);
    console.log(`======================================================\n`);
    const proc = spawn(process.execPath, [path.join(rootDir, file)], {
      stdio: 'inherit',
      cwd: rootDir,
      env: { ...process.env, NODE_ENV: 'test' }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Test '${file}' failed with exit code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

async function main() {
    const start = Date.now();
  console.log(`=== Flow Test Suite Starting (${testFiles.length} suites) ===`);

  for (const testFile of testFiles) {
    await runTest(testFile);
  }

  const duration = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`\n======================================================`);
  console.log(`✓ ALL ${testFiles.length} FLOW TEST SUITES PASSED in ${duration}s!`);
  console.log(`======================================================\n`);
}

main().catch(err => {
  console.error('\n❌ Test Suite Failed:', err.message);
  process.exit(1);
});
