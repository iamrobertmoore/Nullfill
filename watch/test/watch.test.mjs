import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateKey, signReceipt, startProxy, submitAndRecord } from '../nullfill-watch.mjs';
import { receiptBody, verifyReceipt } from '../../web/lib/receipt.js';
import { keccak256 } from '../../web/lib/keccak.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'nullfill-watch-'));
// A signed legacy transaction (it decodes with `cast decode-transaction`). The receipt's hash is
// computed from exactly these bytes.
const RAW = '0xf86c808504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83';

test('keccak256 matches known Ethereum vectors', () => {
  assert.equal(keccak256(new Uint8Array()), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  // A signed legacy transaction, hashed independently with Foundry: `cast keccak <RAW>`.
  const bytes = Uint8Array.from(Buffer.from(RAW.slice(2), 'hex'));
  assert.equal(keccak256(bytes), '0xc587c4e00d511c7a269684e36c0196ae40d3df8d3e2be487c2e364d73c738fc8');
  // A 500 byte input, four sponge blocks, also checked against `cast keccak`.
  const long = Uint8Array.from({ length: 500 }, (_, i) => i % 251);
  assert.equal(keccak256(long), '0xd1346278c6b964973ca0d85063b4e9264739c7b84ff877c8018c865229f44835');
});

test('a rejection becomes a receipt that verifies, and a tampered one does not', async () => {
  const key = loadOrCreateKey(join(scratch(), 'k.pem'));
  const { receipt } = await submitAndRecord({
    upstream: 'test', rawTx: RAW, key, chainId: 46630,
    forward: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Transaction rejected by chain policy' } }),
  });
  assert.equal(receipt.outcome, 'rejected');
  assert.equal(receipt.error.code, -32000);
  assert.equal((await verifyReceipt(receipt)).ok, true);

  const tampered = { ...receipt, error: { ...receipt.error, message: 'nonce too low' } };
  const result = await verifyReceipt(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === 'Watcher signature').ok, false);

  const swapped = { ...receipt, txHash: '0x' + '00'.repeat(32) };
  assert.equal((await verifyReceipt(swapped)).checks.find((c) => c.name === 'Transaction hash').ok, false);
});

test('an accepted submission is recorded too, with the hash the RPC returned', async () => {
  const key = loadOrCreateKey(join(scratch(), 'k.pem'));
  const body = receiptBody({ observedAt: 'now', upstream: 'test', chainId: 1, rawTx: RAW, response: { result: '0xabc' }, watcherPublicKeyHex: key.publicKeyHex });
  const receipt = signReceipt(body, key.privateKey);
  assert.equal(receipt.outcome, 'accepted');
  assert.equal(receipt.result, '0xabc');
  assert.equal((await verifyReceipt(receipt)).ok, true);
});

test('the proxy forwards everything and writes a receipt for a refused transaction', async () => {
  const upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const call = JSON.parse(raw);
      const body = call.method === 'eth_sendRawTransaction'
        ? { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'Transaction rejected by chain policy' } }
        : { jsonrpc: '2.0', id: call.id, result: '0xb626' };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise((ok) => upstream.listen(0, '127.0.0.1', ok));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const outDir = scratch();
  const key = loadOrCreateKey(join(scratch(), 'k.pem'));
  const proxy = await startProxy({ upstream: upstreamUrl, port: 0, outDir, key, chainId: 46630, log: () => {} });
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const post = (method, params) => fetch(proxyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) }).then((r) => r.json());

  assert.equal((await post('eth_chainId', [])).result, '0xb626', 'ordinary calls pass straight through');
  const sent = await post('eth_sendRawTransaction', [RAW]);
  assert.equal(sent.error.code, -32000, 'the sender still sees the real error');

  const files = readdirSync(outDir);
  assert.equal(files.length, 1);
  const receipt = JSON.parse(readFileSync(join(outDir, files[0]), 'utf8'));
  assert.equal(receipt.outcome, 'rejected');
  assert.equal((await verifyReceipt(receipt)).ok, true);

  proxy.close(); upstream.close();
});
