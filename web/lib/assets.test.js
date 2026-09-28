import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAINNET,
  REGISTRY,
  TESTNET,
  allAssets,
  decodeString,
  decodeUint,
  formatUnits,
  registryFor,
  verifyAsset,
} from './assets.js';

/**
 * Real return data, captured from Robinhood Chain rather than invented. A decoder tested against
 * hand-written hex is tested against the author's idea of the ABI, which is the thing most likely to
 * be wrong.
 */
const CHAIN_DATA = {
  // USDG name() on mainnet, 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168. Decodes to "Global Dollar".
  usdgName:
    '0x0000000000000000000000000000000000000000000000000000000000000020' +
    '000000000000000000000000000000000000000000000000000000000000000d' +
    '476c6f62616c20446f6c6c617200000000000000000000000000000000000000',
  // TSLA symbol() on testnet, 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E. Decodes to "TSLA".
  tslaSymbol:
    '0x0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000004' +
    '54534c4100000000000000000000000000000000000000000000000000000000',
  // PLTR name() on testnet, 0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0.
  pltrName:
    '0x0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000015' +
    '50616c616e74697220546563686e6f6c6f676965730000000000000000000000',
  decimals6: '0x0000000000000000000000000000000000000000000000000000000000000006',
};

test('decodes a real ABI string return value', () => {
  assert.equal(decodeString(CHAIN_DATA.usdgName), 'Global Dollar');
  assert.equal(decodeString(CHAIN_DATA.tslaSymbol), 'TSLA');
  assert.equal(decodeString(CHAIN_DATA.pltrName), 'Palantir Technologies');
});

test('decodes the symbol from the offset, not from a fixed position', () => {
  // The trap this guards. The first word is an offset of 0x20, and a decoder that reads the length
  // from that first word gets 32, then reads 32 bytes of zero padding and returns "". That looks
  // exactly like a token with no symbol, which is how this bug hides: it reports a broken token
  // rather than a broken decoder.
  assert.equal(decodeString(CHAIN_DATA.tslaSymbol), 'TSLA');
  assert.notEqual(decodeString(CHAIN_DATA.tslaSymbol), '');
});

test('refuses malformed return data rather than guessing', () => {
  assert.equal(decodeString(null), null);
  assert.equal(decodeString('not hex'), null);
  assert.equal(decodeString('0x'), null);
  assert.equal(decodeString('0x00'), null);
  // A length word claiming more bytes than the payload holds.
  assert.equal(
    decodeString(
      '0x0000000000000000000000000000000000000000000000000000000000000020' +
        '0000000000000000000000000000000000000000000000000000000000000fff' +
        '54534c41',
    ),
    null,
  );
});

test('decodes a uint, and USDG reports six decimals', () => {
  assert.equal(decodeUint(CHAIN_DATA.decimals6), 6);
  assert.equal(decodeUint('0x'), null);
  assert.equal(decodeUint(undefined), null);
});

test('the registry lists USDG first, because it is the cash leg', () => {
  const assets = allAssets(TESTNET);
  assert.equal(assets.length, 6, 'USDG plus five equities');
  assert.equal(assets[0].symbol, 'USDG');
  assert.equal(assets[0].leg, 'cash');
  assert.equal(assets[0].decimals, 6, 'six, not eighteen');
  for (const equity of assets.slice(1)) {
    assert.equal(equity.leg, 'asset');
    assert.equal(equity.decimals, 18);
  }
});

test('an unknown chain returns nothing rather than a default', () => {
  assert.equal(registryFor(1), null);
  assert.deepEqual(allAssets(1), []);
});

test('mainnet lists USDG and no equities', () => {
  const assets = allAssets(MAINNET);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].symbol, 'USDG');
  assert.equal(REGISTRY[MAINNET].equities.length, 0);
});

test('formatUnits is exact at six decimals', () => {
  assert.equal(formatUnits(1000000n, 6), '1');
  assert.equal(formatUnits(1n, 6), '0.000001');
  assert.equal(formatUnits(1234567891n, 6), '1234.567891');
  assert.equal(formatUnits(0n, 6), '0');
  assert.equal(formatUnits(2500000000n, 6), '2500');
  // An amount that a float would round.
  assert.equal(formatUnits(999999999999999999n, 18), '0.999999999999999999');
});

test('verifyAsset reports a match only when the chain agrees', async () => {
  const asset = REGISTRY[TESTNET].usdg;
  const rpcCall = async (method, [call]) => {
    if (call.data === '0x95d89b41') return CHAIN_DATA.tslaSymbol; // deliberately wrong: TSLA
    if (call.data === '0x313ce567') return CHAIN_DATA.decimals6;
    return CHAIN_DATA.usdgName;
  };

  const result = await verifyAsset(rpcCall, asset);
  assert.equal(result.checked, true);
  assert.equal(result.matches, false, 'a wrong symbol must not read as verified');
  assert.equal(result.onChain.symbol, 'TSLA');
  assert.match(result.mismatches[0], /registry says USDG, the chain says TSLA/);
});

test('verifyAsset checks decimals, because that is the number that moves money', async () => {
  const asset = REGISTRY[TESTNET].usdg;
  const rpcCall = async (method, [call]) => {
    if (call.data === '0x95d89b41') return CHAIN_DATA.tslaSymbol.replace('54534c41', '55534447');
    if (call.data === '0x313ce567') {
      // Claims 18 where the registry says 6. A desk that trusted this would be out by 10^12.
      return '0x0000000000000000000000000000000000000000000000000000000000000012';
    }
    return CHAIN_DATA.usdgName;
  };

  const result = await verifyAsset(rpcCall, asset);
  assert.equal(result.matches, false);
  assert.ok(result.mismatches.some((line) => line.startsWith('decimals:')));
});

test('verifyAsset passes the real registry against the real chain data', async () => {
  const rpcCall = async (method, [call]) => {
    if (call.data === '0x95d89b41') return CHAIN_DATA.tslaSymbol;
    if (call.data === '0x313ce567') return '0x0000000000000000000000000000000000000000000000000000000000000012';
    return CHAIN_DATA.pltrName;
  };

  const tsla = REGISTRY[TESTNET].equities[0];
  const result = await verifyAsset(rpcCall, tsla);
  assert.equal(result.matches, true, 'TSLA at 18 decimals, and the chain agrees');
  assert.deepEqual(result.mismatches, []);
});

test('verifyAsset says it did not check rather than claiming a pass', async () => {
  const asset = REGISTRY[TESTNET].usdg;
  const rpcCall = async () => {
    throw new Error('HTTP 429 from the RPC');
  };

  const result = await verifyAsset(rpcCall, asset);
  assert.equal(result.checked, false);
  assert.equal(result.matches, false, 'unreachable is not verified');
  assert.match(result.reason, /429/);
});
