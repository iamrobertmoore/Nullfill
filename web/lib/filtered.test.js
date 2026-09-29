import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFilteredCall, decodeBool, filteredVerdict, FILTER_PRECOMPILE } from './filtered.js';

test('builds the precompile call for a transaction hash', () => {
  const call = isFilteredCall('0x3557fe4ab79553ae32f49af938d6596335aa42d68742bdfc73490d2261e3dbf5');
  assert.equal(call.to, FILTER_PRECOMPILE);
  assert.equal(call.data, '0x85c733a43557fe4ab79553ae32f49af938d6596335aa42d68742bdfc73490d2261e3dbf5');
  assert.throws(() => isFilteredCall('0x1234'));
});

test('reads the boolean the precompile returns, and says so plainly', () => {
  assert.equal(decodeBool('0x' + '0'.repeat(63) + '1'), true);
  assert.equal(decodeBool('0x' + '0'.repeat(64)), false);
  const v = filteredVerdict({ included: true, gasUsed: 20_000_000 });
  assert.equal(v.label, 'Filtered by the chain');
  assert.equal(v.gasSpent, true);
  assert.equal(filteredVerdict({ included: false, gasUsed: 0 }).label, 'Registered as filtered, not yet included');
});
