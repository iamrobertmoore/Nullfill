#!/usr/bin/env node
/**
 * Nullfill Watch, alpha.
 *
 * A screened transaction exists in exactly one place: the error the RPC returns to whoever sent it.
 * Nothing on chain will ever record it. This tool keeps that record.
 *
 *   proxy     Sit between a wallet or script and the RPC. Every eth_sendRawTransaction that passes
 *             through gets a signed receipt, accepted or rejected, written to --out.
 *   send      Submit one raw transaction through the same capture path and print its receipt.
 *   escrows   List every Nullfill escrow an address is party to, with its deadline and whether
 *             anyone may unwind it yet.
 *   verify    Check a receipt: format, transaction hash, and the watcher's signature.
 *   filtered  Ask the chain whether its compliance filter refused a transaction, from the registry
 *             at 0x74. Only refusals that reached the chain through the delayed inbox are listed.
 *   keygen    Create the watcher's Ed25519 key, outside the repository.
 *
 * No dependencies. Node 22 or later.
 */

import { createServer } from 'node:http';
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { receiptBody, signingBytes, verifyReceipt, toHex } from '../web/lib/receipt.js';
import { decodeDescribe, describeCall, NULLFILL } from '../web/lib/orders.js';
import { decodeBool, isFilteredCall } from '../web/lib/filtered.js';

const DEFAULT_RPC = 'https://rpc.testnet.chain.robinhood.com';
const DEFAULT_KEY = join(homedir(), '.nullfill-watch', 'watcher-key.pem');
const DEPLOY_BLOCK = 120343823;
const OPENED_TOPIC = '0xf7a70adea259b13acafb0f26b4541a6b4d493309e7bebe0eeee443607f056ecf';

/* ------------------------------------------------------------------ keys */

export function loadOrCreateKey(path = DEFAULT_KEY) {
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  }
  const privateKey = createPrivateKey(readFileSync(path));
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  return { privateKey, publicKeyHex: Buffer.from(jwk.x, 'base64url').toString('hex') };
}

export function signReceipt(body, privateKey) {
  const signature = sign(null, signingBytes(body), privateKey);
  return { ...body, signature: signature.toString('hex') };
}

/* ------------------------------------------------------------------- rpc */

async function rpc(upstream, method, params) {
  const res = await fetch(upstream, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

/** Submit a raw transaction and turn whatever came back into a signed receipt. */
export async function submitAndRecord({ upstream, rawTx, key, chainId, forward }) {
  const response = forward ? await forward() : await rpc(upstream, 'eth_sendRawTransaction', [rawTx]);
  const body = receiptBody({
    observedAt: new Date().toISOString(),
    upstream,
    chainId,
    rawTx,
    response,
    watcherPublicKeyHex: key.publicKeyHex,
  });
  return { response, receipt: signReceipt(body, key.privateKey) };
}

function save(receipt, outDir) {
  mkdirSync(outDir, { recursive: true });
  const name = `${receipt.observedAt.replace(/[:.]/g, '-')}-${receipt.outcome}-${receipt.txHash.slice(2, 12)}.json`;
  const path = join(outDir, name);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}

/* ------------------------------------------------------------------ proxy */

export function startProxy({ upstream, port, outDir, key, chainId, log = console.log }) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let call;
    try { call = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }

    const forwardRaw = async (payload) => {
      const r = await fetch(upstream, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return r.json();
    };

    if (!Array.isArray(call) && call.method === 'eth_sendRawTransaction') {
      const rawTx = call.params?.[0];
      const { response, receipt } = await submitAndRecord({
        upstream, rawTx, key, chainId, forward: () => forwardRaw(call),
      });
      const path = save(receipt, outDir);
      log(`${receipt.outcome === 'rejected' ? 'REJECTED' : 'accepted'} ${receipt.txHash}${receipt.error ? `  ${receipt.error.code} ${receipt.error.message}` : ''}\n  receipt: ${path}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
      return;
    }

    const response = await forwardRaw(call);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

/* ---------------------------------------------------------------- escrows */

export async function escrowsFor(address, upstream = DEFAULT_RPC) {
  const topic = `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const base = { address: NULLFILL, fromBlock: `0x${DEPLOY_BLOCK.toString(16)}`, toBlock: 'latest' };
  const [asFunder, asBeneficiary] = await Promise.all([
    rpc(upstream, 'eth_getLogs', [{ ...base, topics: [OPENED_TOPIC, null, topic] }]),
    rpc(upstream, 'eth_getLogs', [{ ...base, topics: [OPENED_TOPIC, null, null, topic] }]),
  ]);
  for (const r of [asFunder, asBeneficiary]) if (r.error) throw new Error(r.error.message);
  const refs = [...new Set([...asFunder.result, ...asBeneficiary.result].map((l) => l.topics[1]))];
  const rows = [];
  for (const ref of refs) {
    const r = await rpc(upstream, 'eth_call', [describeCall(ref), 'latest']);
    if (r.error) throw new Error(r.error.message);
    rows.push({ ref, ...decodeDescribe(r.result) });
  }
  return rows;
}

/* -------------------------------------------------------------------- cli */

/** What the chain itself records about a hash: is it in the filter registry, and was it included. */
export async function filteredStatus(hash, upstream = DEFAULT_RPC, call = rpc) {
  const [flag, receipt] = await Promise.all([
    call(upstream, 'eth_call', [isFilteredCall(hash), 'latest']),
    call(upstream, 'eth_getTransactionReceipt', [hash]),
  ]);
  if (flag.error) throw new Error(`the RPC could not read the 0x74 registry: ${flag.error.message}`);
  const r = receipt.result;
  return {
    filtered: decodeBool(flag.result),
    included: Boolean(r),
    failed: r ? r.status === '0x0' : null,
    gasUsed: r ? Number.parseInt(r.gasUsed, 16) : 0,
  };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const cmd = process.argv[2];
  const upstream = arg('rpc', DEFAULT_RPC);

  if (cmd === 'keygen') {
    const key = loadOrCreateKey(arg('key', DEFAULT_KEY));
    console.log(`watcher public key ${key.publicKeyHex}`);
    return;
  }

  if (cmd === 'proxy') {
    const key = loadOrCreateKey(arg('key', DEFAULT_KEY));
    const chainId = Number.parseInt((await rpc(upstream, 'eth_chainId', [])).result, 16);
    const port = Number(arg('port', '8646'));
    await startProxy({ upstream, port, outDir: arg('out', 'receipts'), key, chainId });
    console.log(`Nullfill Watch: point your wallet or script at http://127.0.0.1:${port}\n  upstream ${upstream} (chain ${chainId})\n  watcher key ${key.publicKeyHex}`);
    return;
  }

  if (cmd === 'send') {
    const key = loadOrCreateKey(arg('key', DEFAULT_KEY));
    const chainId = Number.parseInt((await rpc(upstream, 'eth_chainId', [])).result, 16);
    const { receipt } = await submitAndRecord({ upstream, rawTx: arg('raw'), key, chainId });
    const path = save(receipt, arg('out', 'receipts'));
    console.log(`${receipt.outcome}: ${receipt.txHash}${receipt.error ? `\n  the RPC said: ${receipt.error.code} ${receipt.error.message}` : ''}\n  signed receipt: ${path}`);
    return;
  }

  if (cmd === 'escrows') {
    const who = arg('address');
    if (!who) throw new Error('--address is required');
    const now = Date.now() / 1000;
    const rows = await escrowsFor(who, upstream);
    if (!rows.length) console.log('No Nullfill escrows for that address.');
    for (const o of rows) {
      const left = o.deadline - now;
      const when = o.status !== 'Open' ? '' : left > 0
        ? `  unwindable in ${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m`
        : '  past its window: anyone may unwind it now';
      console.log(`${o.ref}  ${o.status.padEnd(8)} ${Number(o.amount) / 1e6} (token ${o.token.slice(0, 8)}…)${when}`);
    }
    return;
  }

  if (cmd === 'verify') {
    const receipt = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const { ok, checks } = await verifyReceipt(receipt);
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (cmd === 'filtered') {
    const hash = arg('hash');
    if (!hash) throw new Error('--hash is required');
    const s = await filteredStatus(hash, upstream);
    if (s.filtered) {
      console.log(s.included
        ? `filtered: the chain's registry lists it, and it was included and ${s.failed ? 'failed' : 'did not fail'} (gas used ${s.gasUsed})`
        : "filtered: the chain's registry lists it, and it has not been included yet. When it is, it will be failed.");
    } else {
      console.log(s.included
        ? `not filtered: the registry does not list it, and it was included (${s.failed ? 'failed' : 'succeeded'})`
        : 'not in the registry and not on chain. If it was refused at the sequencer, only the sender saw it; that is what `proxy` records.');
    }
    return;
  }

  console.log('usage: nullfill-watch <keygen|proxy|send|escrows|verify|filtered> [--rpc URL] [--port N] [--out DIR] [--raw 0x..] [--address 0x..] [--hash 0x..]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}

export { toHex };
