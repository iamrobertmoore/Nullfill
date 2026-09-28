import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCall, decodeDescribe, NULLFILL } from './orders.js';

// The real answer the chain gave for order 2 on 28 September 2026, while it was still open.
const ORDER_2_OPEN =
  '0x0000000000000000000000000000000000000000000000000000000000000001' +
  '0000000000000000000000001f73e798acc33eb93eb61825591d9b73c7ee7d4a' +
  '000000000000000000000000aae247dc771532320050416d0e83bbe7220057d9' +
  '0000000000000000000000005565a33a63ee42fc8bae96f823182cf7269ba11a' +
  '0000000000000000000000007e955252e15c84f5768b83c41a71f9eba181802f' +
  '0000000000000000000000000000000000000000000000000000000002faf080' +
  '000000000000000000000000000000000000000000000000000000006abbcb8b' +
  '0000000000000000000000000000000000000000000000000000000000000000';

test('decodes a real describe() answer from the live contract', () => {
  const o = decodeDescribe(ORDER_2_OPEN);
  assert.equal(o.status, 'Open');
  assert.equal(o.unwindTo, '0x5565a33a63ee42fc8bae96f823182cf7269ba11a');
  assert.equal(o.token, '0x7e955252e15c84f5768b83c41a71f9eba181802f');
  assert.equal(o.amount, 50_000_000n, '50 USDG at six decimals');
  assert.equal(o.deadline, 1790692235);
  assert.equal(o.unwindable, false);
});

test('builds the call and refuses a malformed reference', () => {
  const call = describeCall('0x' + 'ab'.repeat(32));
  assert.equal(call.to, NULLFILL);
  assert.equal(call.data.length, 2 + 8 + 64);
  assert.throws(() => describeCall('0x1234'));
  assert.throws(() => decodeDescribe('0x00'));
});
