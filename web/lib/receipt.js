/**
 * Nullfill Watch receipts: the one record of a transaction the chain refused.
 *
 * A screened transaction leaves nothing on chain. The only place the refusal exists is the error
 * the RPC returned to whoever sent it. The watcher keeps that error, with the raw signed transaction,
 * and signs the lot with an Ed25519 key, so it can be shown to a counterparty or an auditor later.
 *
 * This file is shared: the watcher (Node) signs with it and the console (browser) verifies with it.
 * Both use WebCrypto Ed25519 and keccak256 from ./keccak.js. No dependencies.
 */

import { keccak256, hexToBytes } from './keccak.js';

export const RECEIPT_KIND = 'nullfill.watch.receipt/v1';

/** Stable JSON: keys sorted at every level, so the bytes that were signed can be rebuilt exactly. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The bytes a receipt's signature covers: everything except the signature itself. */
export function signingBytes(receipt) {
  const { signature, ...body } = receipt;
  return new TextEncoder().encode(canonical(body));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Build the unsigned body of a receipt from what the RPC said. */
export function receiptBody({ observedAt, upstream, chainId, rawTx, response, watcherPublicKeyHex }) {
  const rejected = Boolean(response && response.error);
  return {
    kind: RECEIPT_KIND,
    observedAt,
    upstream,
    chainId,
    method: 'eth_sendRawTransaction',
    rawTx,
    txHash: keccak256(hexToBytes(rawTx)),
    outcome: rejected ? 'rejected' : 'accepted',
    error: rejected ? { code: response.error.code ?? null, message: String(response.error.message ?? '') } : null,
    result: rejected ? null : response?.result ?? null,
    onChainTrace: rejected ? 'none: a rejected submission is never sequenced' : 'see the receipt on chain',
    watcher: { alg: 'Ed25519', publicKey: watcherPublicKeyHex },
  };
}

/**
 * Check a receipt. Returns every check with a plain verdict, rather than one boolean, so a reader
 * can see which part failed.
 */
export async function verifyReceipt(receipt) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('Format', receipt?.kind === RECEIPT_KIND, receipt?.kind ?? 'missing kind');

  let hashOk = false;
  try {
    const computed = keccak256(hexToBytes(receipt.rawTx));
    hashOk = computed === String(receipt.txHash).toLowerCase();
    add('Transaction hash', hashOk, hashOk ? 'matches keccak256 of the raw transaction' : `raw transaction hashes to ${computed}`);
  } catch (error) {
    add('Transaction hash', false, `could not hash the raw transaction: ${error.message}`);
  }

  let sigOk = false;
  try {
    const key = await globalThis.crypto.subtle.importKey(
      'raw', hexToBytes(receipt.watcher.publicKey), { name: 'Ed25519' }, false, ['verify'],
    );
    sigOk = await globalThis.crypto.subtle.verify(
      { name: 'Ed25519' }, key, hexToBytes(receipt.signature), signingBytes(receipt),
    );
    add('Watcher signature', sigOk, sigOk ? 'valid Ed25519 signature over the canonical receipt' : 'does not match: the receipt was changed after signing, or signed by a different key');
  } catch (error) {
    add('Watcher signature', false, `could not verify: ${error.message}`);
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export { toHex };
