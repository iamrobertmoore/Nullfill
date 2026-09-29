/**
 * The chain's own record of transactions its compliance filter refused.
 *
 * ArbOS ships a precompile at 0x74 (ArbFilteredTransactionsManager). An authorised
 * filterer registers the hash of a restricted transaction that arrived through the delayed inbox,
 * so that when it is force-included it is failed instead of executed. `isTransactionFiltered(hash)`
 * answers from that registry.
 *
 * What it covers, measured on Robinhood Chain mainnet on 29 September 2026: 1,355 distinct
 * transaction hashes registered between 30 June and 16 September 2026, every sampled one included
 * with a failed receipt. What it does not cover: a transaction refused at the sequencer's door is
 * never registered, because it never reaches the chain at all.
 */

export const FILTER_PRECOMPILE = '0x0000000000000000000000000000000000000074';
export const IS_FILTERED_SELECTOR = '0x85c733a4'; // cast sig "isTransactionFiltered(bytes32)"

export function isFilteredCall(txHash) {
  const clean = txHash.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error('A transaction hash is 32 bytes of hex');
  return { to: FILTER_PRECOMPILE, data: IS_FILTERED_SELECTOR + clean };
}

export function decodeBool(hex) {
  return BigInt(hex || '0x0') === 1n;
}

/** A verdict for a transaction the chain itself says it filtered. */
export function filteredVerdict({ included, gasUsed }) {
  return {
    outcome: 'filtered',
    label: included ? 'Filtered by the chain' : 'Registered as filtered, not yet included',
    tone: 'bad',
    onChainTrace: included ? 'A failed receipt, and the hash in the 0x74 registry' : 'The hash in the 0x74 registry',
    gasSpent: included ? gasUsed > 0 : false,
    certain: true,
    evidence: included
      ? [
          'The transaction was included and failed.',
          "Robinhood Chain's filtered-transactions registry (the ArbOS precompile at 0x74) lists this hash, so the compliance filter refused it, not a contract.",
          'It came in through the delayed inbox, the route the sequencer cannot refuse at the door, so the chain records it and fails it instead.',
        ]
      : [
          "Robinhood Chain's filtered-transactions registry (0x74) lists this hash, but the transaction has not been included.",
          'When it is force-included it will be failed, not executed.',
        ],
  };
}
