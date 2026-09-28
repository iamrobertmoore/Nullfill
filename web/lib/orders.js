/**
 * Real orders on the live contract, read back from the chain rather than described.
 *
 * `describe(bytes32)` returns eight words: status, funder, beneficiary, unwindTo, token, amount,
 * deadline, unwindable. This module builds the call and decodes the answer, with no dependencies,
 * so the same code runs in the browser and under `node --test`.
 */

export const NULLFILL = '0x71029fac49E9b45CCC377812aEc01509FFD383A1';
export const DESCRIBE_SELECTOR = '0x0220ef28'; // cast sig "describe(bytes32)"
export const STATUS = ['None', 'Open', 'Settled', 'Unwound'];

export const LIVE_ORDERS = [
  {
    label: 'Order 1',
    ref: '0xfad69ced7f9b1bf95844435440a669de0644dfbf7a378f571f412529e599acee',
    story: 'Opened, then settled. The counterparty holds the USDG.',
    txs: [
      ['open', '0xaf53bd4607b7ef088d9d80c02701d742f51c7f7b2518e9e2694d57fd9f0573f4'],
      ['settle', '0xb3c300d0c5040e7d1023376fb860cdd8f3e1abf7cc8aa06104d7b713d3b8d173'],
    ],
  },
  {
    label: 'Order 2',
    ref: '0x7fb40dea2f7e756989161f233dc86cd0a83d6e98b9558c1e460e20d7a351cc90',
    story: 'Recovery address named up front. After the 24 hour window, a wallet that never touched the order unwinds it, and the USDG goes to the recovery address.',
    txs: [['open', '0x1fa994e04fea8a82ab3550a12529f2c6c2907911e5eeede870ff527680265bfe']],
  },
];

export function describeCall(ref) {
  const clean = ref.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error('A reference is 32 bytes of hex');
  return { to: NULLFILL, data: DESCRIBE_SELECTOR + clean };
}

export function decodeDescribe(hex) {
  const body = (hex || '').replace(/^0x/, '');
  if (body.length < 64 * 8) throw new Error('Short answer from describe()');
  const word = (i) => body.slice(i * 64, (i + 1) * 64);
  const addr = (i) => `0x${word(i).slice(24)}`;
  const big = (i) => BigInt(`0x${word(i)}`);
  const status = Number(big(0));
  return {
    status: STATUS[status] ?? `Unknown (${status})`,
    funder: addr(1),
    beneficiary: addr(2),
    unwindTo: addr(3),
    token: addr(4),
    amount: big(5),
    deadline: Number(big(6)),
    unwindable: big(7) === 1n,
  };
}
