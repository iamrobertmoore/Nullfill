/**
 * The four outcomes a submitted transaction can have on Robinhood Chain.
 *
 * This module is deliberately pure. It takes what an RPC will tell you and returns a verdict, so
 * the same logic runs in the browser console and in the command line monitor and they cannot drift
 * apart.
 *
 * The distinction that matters, and the one every other tool gets wrong: a screened transaction
 * does not fail, it does not appear. There is no revert to read, no failed receipt, no event and no
 * gas. The only place the information exists at all is the submitter's own client, and only as a
 * transient error string. Nothing on chain records that anything was attempted.
 */

export const OUTCOME = {
  SETTLED: 'settled',
  REVERTED: 'reverted',
  SCREENED: 'screened',
  NO_TRACE: 'no-trace',
  PENDING: 'pending',
  REJECTED: 'rejected',
};

/**
 * The error the sequencer returns when a transaction is filtered. Observed against a Nitro node
 * with `execution.transaction-filtering` enabled: JSON-RPC code -32000, message
 * "Transaction rejected by chain policy".
 */
export const SCREENING_ERROR_PATTERN = /rejected by chain policy/i;

const LABELS = {
  [OUTCOME.SETTLED]: {
    label: 'Settled',
    tone: 'good',
    onChainTrace: 'Full record',
    gasSpent: true,
    note: 'The normal path. Receipt, events, state change.',
  },
  [OUTCOME.REVERTED]: {
    label: 'Failed',
    tone: 'warn',
    onChainTrace: 'Receipt with a failure status',
    gasSpent: true,
    note: 'The contract refused it. Everyone can see that it failed.',
  },
  [OUTCOME.SCREENED]: {
    label: 'Screened',
    tone: 'bad',
    onChainTrace: 'Nothing at all',
    gasSpent: false,
    note: 'Rejected before it was ever sequenced. No trace, no event, no gas.',
  },
  [OUTCOME.NO_TRACE]: {
    label: 'No trace',
    tone: 'bad',
    onChainTrace: 'Nothing at all',
    gasSpent: false,
    note: 'Submitted, never appeared, and the window is closed. Indistinguishable from screened.',
  },
  [OUTCOME.PENDING]: {
    label: 'Awaiting inclusion',
    tone: 'warn',
    onChainTrace: 'Nothing yet',
    gasSpent: false,
    note: 'Inside the force inclusion window. The outcome is still genuinely unknown.',
  },
  [OUTCOME.REJECTED]: {
    label: 'Rejected',
    tone: 'warn',
    onChainTrace: 'Nothing at all',
    gasSpent: false,
    note: 'The node refused the submission for some other reason. Read the message.',
  },
};

/**
 * Classify a submitted transaction.
 *
 * @param {object} observation
 * @param {{accepted: boolean, error: string|null}} observation.submission What the node said when
 *   the transaction was sent.
 * @param {{status: 'success'|'failure'}|null} observation.receipt The receipt, or null if there is
 *   none yet.
 * @param {number} observation.blocksSinceSubmission Blocks observed since submission.
 * @param {number} observation.windowBlocks The force inclusion window, in blocks.
 * @returns {{outcome: string, label: string, tone: string, onChainTrace: string, gasSpent: boolean,
 *   note: string, evidence: string, certain: boolean}}
 */
export function classify({ submission, receipt, blocksSinceSubmission, windowBlocks }) {
  if (!submission || submission.accepted !== true) {
    const message = (submission && submission.error) || 'no error reported';
    const screened = SCREENING_ERROR_PATTERN.test(message);

    return verdict(screened ? OUTCOME.SCREENED : OUTCOME.REJECTED, [
      `Node refused the submission: ${message}`,
    ]);
  }

  if (receipt && receipt.status === 'success') {
    return verdict(OUTCOME.SETTLED, ['Receipt found with a success status.']);
  }

  if (receipt && receipt.status === 'failure') {
    return verdict(OUTCOME.REVERTED, [
      'Receipt found with a failure status.',
      'The receipt alone cannot tell you whether the contract reverted or whether the transaction ' +
        'arrived by force inclusion and was forcibly failed. Both look identical on chain.',
    ]);
  }

  if (blocksSinceSubmission >= windowBlocks) {
    return verdict(OUTCOME.NO_TRACE, [
      `No receipt after ${blocksSinceSubmission} blocks, and the ${windowBlocks} block force ` +
        'inclusion window has closed.',
      'A screened transaction and a dropped transaction are indistinguishable from outside. Both ' +
        'leave no trace at all.',
    ]);
  }

  return verdict(OUTCOME.PENDING, [
    `${blocksSinceSubmission} of ${windowBlocks} blocks elapsed.`,
    'A transaction submitted through the delayed inbox can still arrive, so the outcome is not ' +
      'yet knowable.',
  ]);
}

function verdict(outcome, evidence) {
  const meta = LABELS[outcome];

  return {
    outcome,
    ...meta,
    evidence,
    // Screening is only ever directly observable at submit time, in the submitter's own client.
    // Everything else is inference from the absence of a receipt.
    certain: outcome === OUTCOME.SETTLED || outcome === OUTCOME.SCREENED || outcome === OUTCOME.REVERTED,
  };
}

/** True when this outcome means funds may be stranded and someone should act. */
export function needsAction(outcome) {
  return outcome === OUTCOME.SCREENED || outcome === OUTCOME.NO_TRACE;
}

/**
 * What the console offers the user, per outcome. Keeping this next to the classifier stops the UI
 * inventing a remedy the chain cannot actually deliver.
 */
export function remedy(outcome) {
  switch (outcome) {
    case OUTCOME.SCREENED:
      return 'The escrow is still open. Nothing was spent. Nominate a clean recovery address and ' +
        'let the window close, then anyone can unwind it.';
    case OUTCOME.NO_TRACE:
      return 'Past the window. Unwind is now permissionless, so any address can release the ' +
        'escrow to the nominated recovery address.';
    case OUTCOME.PENDING:
      return 'Wait. Unwinding now would be wrong, because a force included transaction can still ' +
        'land and would then double settle.';
    case OUTCOME.REVERTED:
      return 'The escrow is untouched and still open. The counterparty can retry with more gas or ' +
        'different arguments.';
    case OUTCOME.SETTLED:
      return 'Nothing to do.';
    default:
      return 'Read the node error before acting.';
  }
}
