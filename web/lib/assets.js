/**
 * The settlement asset registry.
 *
 * A mirror of `contracts/src/RobinhoodChain.sol`. It has to be duplicated because a static page cannot
 * call a Solidity library, and the duplication is the reason the panel that renders this checks every
 * address against the chain instead of printing it. A hand-written address is a claim, and the point
 * of the panel is to show you whether the claim survives contact with the chain.
 *
 * USDG is the cash leg. On this chain a settlement has two sides: tokenised equity one way, dollars
 * the other. The dollars are USDG, which is the stablecoin Robinhood Chain's own ecosystem page lists
 * under Stablecoin, supplied by Paxos.
 */

/** Chain ids this registry knows about. */
export const TESTNET = 46630;
export const MAINNET = 4663;

export const CHAIN_NAMES = {
  [TESTNET]: 'Robinhood Chain testnet',
  [MAINNET]: 'Robinhood Chain mainnet',
};

/**
 * Verified 28 September 2026 by reading each contract on chain. `verifiedOn` is a date, not a
 * guarantee: a token can be upgraded, which is why `verifyAsset` exists and why the panel runs it.
 */
export const REGISTRY = {
  [TESTNET]: {
    usdg: {
      address: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
      symbol: 'USDG',
      name: 'Global Dollar',
      decimals: 6,
      leg: 'cash',
      verifiedOn: '2026-09-28',
      note: 'The cash leg. A verified USDG implementation behind an ERC1967 proxy, with role gated mint and no public mint.',
    },
    equities: [
      { address: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E', symbol: 'TSLA', name: 'Tesla', decimals: 18, leg: 'asset' },
      { address: '0x71178BAc73cBeb415514eB542a8995b82669778d', symbol: 'AMD', name: 'AMD', decimals: 18, leg: 'asset' },
      { address: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02', symbol: 'AMZN', name: 'Amazon', decimals: 18, leg: 'asset' },
      { address: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93', symbol: 'NFLX', name: 'Netflix', decimals: 18, leg: 'asset' },
      { address: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0', symbol: 'PLTR', name: 'Palantir Technologies', decimals: 18, leg: 'asset' },
    ],
  },
  [MAINNET]: {
    usdg: {
      address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      symbol: 'USDG',
      name: 'Global Dollar',
      decimals: 6,
      leg: 'cash',
      verifiedOn: '2026-09-28',
      note: 'The same USDG, on mainnet.',
    },
    equities: [],
  },
};

/** ERC-20 method selectors, so the panel can read a token without an ABI file. */
export const SELECTOR = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
};

/** The registry for a chain id, or null if this page does not know that chain. */
export function registryFor(chainId) {
  return REGISTRY[chainId] ?? null;
}

/** Every asset this registry lists for a chain, cash leg first. */
export function allAssets(chainId) {
  const chain = registryFor(chainId);
  if (!chain) return [];
  return [chain.usdg, ...chain.equities];
}

/**
 * Decode an ABI-encoded `string` return value.
 *
 * Worth doing carefully rather than approximately. A hand-rolled version of this that reads the
 * length from the wrong offset returns an empty string for a token that has a perfectly good symbol,
 * which looks exactly like a broken token. That mistake was made once while writing the fork test for
 * the contract side, and this is the corrected version, with a test that would have caught it.
 */
export function decodeString(hex) {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) return null;
  const data = hex.slice(2);
  if (data.length < 128) return null;

  const offset = Number.parseInt(data.slice(0, 64), 16) * 2;
  if (!Number.isFinite(offset) || offset + 64 > data.length) return null;

  const length = Number.parseInt(data.slice(offset, offset + 64), 16);
  const start = offset + 64;
  const end = start + length * 2;
  if (!Number.isFinite(length) || end > data.length) return null;

  const bytes = data.slice(start, end).match(/../g) ?? [];
  return bytes.map((byte) => String.fromCharCode(Number.parseInt(byte, 16))).join('');
}

/** Decode an ABI-encoded `uint8` or `uint256` return value. */
export function decodeUint(hex) {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) return null;
  const data = hex.slice(2);
  if (data.length < 64) return null;
  const value = Number.parseInt(data.slice(0, 64), 16);
  return Number.isFinite(value) ? value : null;
}

/**
 * Read an asset off the chain and say whether it is what the registry claims.
 *
 * Returns `{ checked: false, reason }` rather than throwing when the chain cannot be reached. A panel
 * that renders "not checked" is honest; one that renders a green tick it did not earn is not.
 */
export async function verifyAsset(rpcCall, asset) {
  try {
    const [symbolHex, decimalsHex, nameHex] = await Promise.all([
      rpcCall('eth_call', [{ to: asset.address, data: SELECTOR.symbol }, 'latest']),
      rpcCall('eth_call', [{ to: asset.address, data: SELECTOR.decimals }, 'latest']),
      rpcCall('eth_call', [{ to: asset.address, data: SELECTOR.name }, 'latest']),
    ]);

    const onChain = {
      symbol: decodeString(symbolHex),
      decimals: decodeUint(decimalsHex),
      name: decodeString(nameHex),
    };

    const mismatches = [];
    if (onChain.symbol !== asset.symbol) {
      mismatches.push(`symbol: registry says ${asset.symbol}, the chain says ${onChain.symbol}`);
    }
    if (onChain.decimals !== asset.decimals) {
      mismatches.push(`decimals: registry says ${asset.decimals}, the chain says ${onChain.decimals}`);
    }

    return { checked: true, matches: mismatches.length === 0, onChain, mismatches };
  } catch (error) {
    return { checked: false, matches: false, reason: error.message, onChain: null, mismatches: [] };
  }
}

/**
 * Format a raw amount at a given number of decimals, exactly.
 *
 * Integer arithmetic on a string, so a six decimal amount never goes through a float. USDG at six
 * decimals is the reason: `1234.567891e6` is 1234567891, and a float would render that as something
 * close but not equal.
 */
export function formatUnits(raw, decimals) {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals);
  const trimmed = fraction.replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${trimmed ? `.${trimmed}` : ''}`;
}
