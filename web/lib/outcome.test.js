import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OUTCOME, classify, needsAction, remedy, SCREENING_ERROR_PATTERN } from './outcome.js';

const WINDOW = 100;

test('a screened submission is reported as screened, not as a failure', () => {
  const result = classify({
    submission: { accepted: false, error: 'Transaction rejected by chain policy' },
    receipt: null,
    blocksSinceSubmission: 0,
    windowBlocks: WINDOW,
  });

  assert.equal(result.outcome, OUTCOME.SCREENED);
  assert.equal(result.onChainTrace, 'Nothing at all');
  assert.equal(result.gasSpent, false);
});

test('the screening error is matched the way Nitro actually spells it', () => {
  assert.ok(SCREENING_ERROR_PATTERN.test('Transaction rejected by chain policy'));
  assert.ok(!SCREENING_ERROR_PATTERN.test('insufficient funds for gas * price + value'));
});

test('a different submission error is not misreported as screening', () => {
  const result = classify({
    submission: { accepted: false, error: 'nonce too low' },
    receipt: null,
    blocksSinceSubmission: 0,
    windowBlocks: WINDOW,
  });

  assert.equal(result.outcome, OUTCOME.REJECTED);
});

test('a success receipt settles', () => {
  const result = classify({
    submission: { accepted: true, error: null },
    receipt: { status: 'success' },
    blocksSinceSubmission: 1,
    windowBlocks: WINDOW,
  });

  assert.equal(result.outcome, OUTCOME.SETTLED);
  assert.equal(result.gasSpent, true);
});

test('a failure receipt does not claim to know why it failed', () => {
  const result = classify({
    submission: { accepted: true, error: null },
    receipt: { status: 'failure' },
    blocksSinceSubmission: 1,
    windowBlocks: WINDOW,
  });

  assert.equal(result.outcome, OUTCOME.REVERTED);
  assert.match(result.evidence.join(' '), /cannot tell you whether the contract reverted/);
});

test('no receipt inside the window is pending, not screened', () => {
  const result = classify({
    submission: { accepted: true, error: null },
    receipt: null,
    blocksSinceSubmission: 40,
    windowBlocks: WINDOW,
  });

  assert.equal(result.outcome, OUTCOME.PENDING);
  assert.equal(result.certain, false);
});

test('no receipt after the window is no-trace, and is not claimed as certain', () => {
  const result = classify({
    submission: { accepted: true, error: null },
    receipt: null,
    blocksSinceSubmission: 101,
    windowBlocks: WINDOW,
  });

  assert.equal(result.outcome, OUTCOME.NO_TRACE);
  assert.equal(result.certain, false);
});

test('only the outcomes that strand funds ask for action', () => {
  assert.ok(needsAction(OUTCOME.SCREENED));
  assert.ok(needsAction(OUTCOME.NO_TRACE));
  assert.ok(!needsAction(OUTCOME.SETTLED));
  assert.ok(!needsAction(OUTCOME.REVERTED));
  assert.ok(!needsAction(OUTCOME.PENDING));
});

test('pending never offers an unwind, because that would double settle', () => {
  assert.match(remedy(OUTCOME.PENDING), /double settle/);
});

test('every outcome has a remedy', () => {
  for (const outcome of Object.values(OUTCOME)) {
    assert.equal(typeof remedy(outcome), 'string');
    assert.ok(remedy(outcome).length > 0, `${outcome} has no remedy`);
  }
});
