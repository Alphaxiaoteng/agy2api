import assert from 'node:assert/strict';
import {
  parseQuotaSummary,
  quotaSummaryUrlFromModelsUrl,
  classifyQuotaWindow,
  remainingFractionFromBucket
} from '../src/auth/quotaSummary.js';

const now = Date.parse('2026-08-25T10:00:00Z');

assert.equal(
  quotaSummaryUrlFromModelsUrl('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'),
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
);

assert.equal(
  classifyQuotaWindow({ window: 'WEEKLY', bucketId: 'gemini' }, now),
  'weekly'
);
assert.equal(
  classifyQuotaWindow({ window: 'FIVE_HOUR', bucketId: 'gemini-5h' }, now),
  'session'
);
assert.equal(
  remainingFractionFromBucket({ remaining: { case: 'remainingFraction', value: 0.42 } }),
  0.42
);

const parsed = parseQuotaSummary({
  groups: [
    {
      displayName: 'Gemini models',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'WEEKLY', remainingFraction: 0.4, resetTime: '2026-08-31T10:00:00Z' },
        { bucketId: 'gemini-5h', window: 'FIVE_HOUR', remainingFraction: 0.9, resetTime: '2026-08-25T12:00:00Z' }
      ]
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { bucketId: 'claude-weekly', window: 'weekly', remaining: { remainingFraction: 0.2 }, resetTime: '2026-08-28T10:00:00Z' }
      ]
    }
  ]
}, now);

assert.equal(parsed.weekly.gemini.r, 0.4);
assert.equal(parsed.weekly.gemini.t, '2026-08-31T10:00:00Z');
assert.equal(parsed.weekly.banana.t, '2026-08-31T10:00:00Z');
assert.equal(parsed.weekly.claude.r, 0.2);
assert.equal(parsed.weekly.other.t, '2026-08-28T10:00:00Z');
assert.equal(parsed.session.gemini.r, 0.9);

const nested = parseQuotaSummary({
  response: {
    groups: [
      {
        displayName: 'Gemini',
        buckets: [
          { name: 'week-bucket', remainingFraction: 0.1, resetTime: '2026-09-01T00:00:00Z' }
        ]
      }
    ]
  }
}, now);
assert.equal(nested.weekly.gemini.r, 0.1);

console.log('quota-summary parse passed');
