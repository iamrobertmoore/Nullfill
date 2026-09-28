/**
 * Keccak-256, the hash Ethereum uses for transaction hashes. Pure JavaScript, no dependencies, so
 * the same file runs in the browser and in Node. Lanes are held as pairs of 32 bit words.
 */

const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000], [0x80008000, 0x80000000],
  [0x0000808b, 0x00000000], [0x80000001, 0x00000000], [0x80008081, 0x80000000], [0x00008009, 0x80000000],
  [0x0000008a, 0x00000000], [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000], [0x00008003, 0x80000000],
  [0x00008002, 0x80000000], [0x00000080, 0x80000000], [0x0000800a, 0x00000000], [0x8000000a, 0x80000000],
  [0x80008081, 0x80000000], [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];

// Rotation offsets and the pi permutation, indexed by lane x + 5y.
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

function rotl(lo, hi, n) {
  if (n === 0) return [lo, hi];
  if (n >= 32) { [lo, hi] = [hi, lo]; n -= 32; }
  if (n === 0) return [lo, hi];
  return [((lo << n) | (hi >>> (32 - n))) >>> 0, ((hi << n) | (lo >>> (32 - n))) >>> 0];
}

function permute(s) {
  const b = new Array(50);
  const c = new Array(10);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      c[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
      c[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
    }
    for (let x = 0; x < 5; x++) {
      const [rl, rh] = rotl(c[2 * ((x + 1) % 5)], c[2 * ((x + 1) % 5) + 1], 1);
      const dl = c[2 * ((x + 4) % 5)] ^ rl;
      const dh = c[2 * ((x + 4) % 5) + 1] ^ rh;
      for (let y = 0; y < 25; y += 5) {
        s[2 * (x + y)] ^= dl;
        s[2 * (x + y) + 1] ^= dh;
      }
    }
    // rho and pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        const [l, h] = rotl(s[2 * i] >>> 0, s[2 * i + 1] >>> 0, ROT[i]);
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        b[2 * j] = l;
        b[2 * j + 1] = h;
      }
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = x + y;
        const i1 = ((x + 1) % 5) + y;
        const i2 = ((x + 2) % 5) + y;
        s[2 * i] = b[2 * i] ^ (~b[2 * i1] & b[2 * i2]);
        s[2 * i + 1] = b[2 * i + 1] ^ (~b[2 * i1 + 1] & b[2 * i2 + 1]);
      }
    }
    // iota
    s[0] ^= RC[round][0];
    s[1] ^= RC[round][1];
  }
}

/** keccak256 of a Uint8Array, as a 0x-prefixed hex string. */
export function keccak256(bytes) {
  const rate = 136;
  const s = new Array(50).fill(0);
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 4; i++) {
      const w = padded[off + 4 * i] | (padded[off + 4 * i + 1] << 8) | (padded[off + 4 * i + 2] << 16) | (padded[off + 4 * i + 3] << 24);
      s[i] ^= w;
    }
    permute(s);
  }
  let hex = '0x';
  for (let i = 0; i < 8; i++) {
    const w = s[i] >>> 0;
    for (let k = 0; k < 4; k++) hex += ((w >>> (8 * k)) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(hex) {
  const clean = hex.replace(/^0x/, '');
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error('Not hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}
