/**
 * Nullfill settlement console.
 *
 * Two jobs. First, replay a recorded scenario so the console can be read without a wallet. Second,
 * classify a real transaction hash against a live RPC, using the same pure classifier the command
 * line monitor uses.
 */

import { OUTCOME, classify, needsAction, remedy } from './lib/outcome.js';
import { CHAIN_NAMES, TESTNET, allAssets, verifyAsset } from './lib/assets.js';
import { LIVE_ORDERS, describeCall, decodeDescribe } from './lib/orders.js';
import { startMotion, setWindowProgress } from './lib/motion.js';
import { verifyReceipt } from './lib/receipt.js';
import { isFilteredCall, decodeBool, filteredVerdict } from './lib/filtered.js';

const FORCE_INCLUSION_WINDOW_BLOCKS = 100; // illustrative; the contract uses 24 hours of wall clock

const EXPLORER = {
  46630: 'https://explorer.testnet.chain.robinhood.com',
  4663: 'https://robinhoodchain.blockscout.com',
};

const state = {
  rpc: 'https://rpc.testnet.chain.robinhood.com',
  settlements: [],
  selected: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
};

/* ------------------------------------------------------------------ network */

async function rpcCall(method, params = []) {
  const response = await fetch(state.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} from the RPC`);

  const body = await response.json();
  if (body.error) throw new Error(body.error.message || 'RPC error');

  return body.result;
}

async function probeNetwork() {
  const dot = $('#net-dot');
  try {
    const chainId = await rpcCall('eth_chainId');
    const decimal = Number.parseInt(chainId, 16);
    dot.className = 'dot online';
    dot.title = `Connected, chain id ${decimal}`;
  } catch (error) {
    dot.className = 'dot offline';
    dot.title = `Not reachable from the browser: ${error.message}`;
  }
}

/* ------------------------------------------------------------------- ledger */

async function loadLedger() {
  const response = await fetch('./data/ledger.json');
  if (!response.ok) throw new Error(`could not load the ledger (HTTP ${response.status})`);
  const data = await response.json();
  state.settlements = data.settlements;
  return data;
}

function outcomeMeta(outcome) {
  switch (outcome) {
    case OUTCOME.SETTLED:
      return { label: 'Settled', tone: 'good' };
    case OUTCOME.PENDING:
      return { label: 'Awaiting inclusion', tone: 'warn' };
    case OUTCOME.SCREENED:
      return { label: 'Screened', tone: 'bad' };
    case OUTCOME.NO_TRACE:
      return { label: 'Funds stranded', tone: 'bad' };
    case OUTCOME.REVERTED:
      return { label: 'Failed', tone: 'warn' };
    default:
      return { label: 'Unknown', tone: 'warn' };
  }
}

function renderLedger() {
  const ledger = $('#ledger');
  ledger.replaceChildren();

  ledger.append(
    el('div', { className: 'ledger-head' }, [
      el('div', {}, 'Reference'),
      el('div', {}, 'Route'),
      el('div', {}, 'Submitted'),
      el('div', {}, 'State'),
    ]),
  );

  for (const settlement of state.settlements) {
    const meta = outcomeMeta(settlement.outcome);
    const row = el('button', {
      type: 'button',
      className: `ledger-row${meta.tone === 'bad' ? ' flag' : ''}`,
      'aria-current': String(state.selected === settlement.ref),
    }, [
      el('span', { className: 'ref' }, settlement.ref),
      el('span', { className: 'route' }, settlement.route),
      el('span', { className: 'when' }, settlement.submittedAt),
      el('span', { className: 'status' }, [
        el('span', { className: `pill ${meta.tone}` }, meta.label),
      ]),
    ]);

    row.addEventListener('click', () => selectSettlement(settlement.ref));
    ledger.append(row);
  }
}

function selectSettlement(ref, scroll = true) {
  state.selected = ref;
  const settlement = state.settlements.find((s) => s.ref === ref);
  renderLedger();
  renderDetail(settlement);
  $('#detail-panel').hidden = false;
  if (scroll) $('#detail-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderDetail(settlement) {
  if (!settlement) return;

  const meta = outcomeMeta(settlement.outcome);

  $('#detail-title').textContent = `${settlement.ref} · ${settlement.amount} ${settlement.asset}`;
  $('#detail-sub').textContent = settlement.note;

  const facts = el('dl', { className: 'detail-grid' }, [
    fact('Route', settlement.route),
    fact('Submitted', settlement.submittedAt),
    fact('Funder', settlement.funder, 'mono'),
    fact('Beneficiary', settlement.beneficiary, 'mono'),
    fact('Recovery address', settlement.unwindTo, 'mono'),
    fact('Deadline', settlement.deadline),
    fact('Gas spent', settlement.gasSpent),
    fact('On-chain trace', settlement.onChainTrace),
  ]);

  const timeline = el('ul', { className: 'timeline' },
    settlement.timeline.map((step) =>
      el('li', { className: step.kind }, [
        el('span', { className: 't' }, step.t),
        document.createTextNode(step.text),
      ]),
    ),
  );

  const body = $('#detail-body');
  body.replaceChildren();

  body.append(
    el('p', {}, [el('span', { className: `pill ${meta.tone}` }, meta.label)]),
    facts,
    el('h3', { style: 'font-size:15px;margin:22px 0 12px' }, 'What happened'),
    timeline,
  );

  if (needsAction(settlement.outcome)) {
    body.append(el('div', { className: 'remedy' }, remedy(settlement.outcome)));
  }
}

function fact(label, value, className) {
  return el('div', {}, [
    el('dt', {}, label),
    el('dd', { className: className || '' }, value ?? 'n/a'),
  ]);
}

/* --------------------------------------------------------------- classifier */

function renderVerdict(result, source) {
  const slot = $('#verdict');
  slot.replaceChildren();

  const body = el('div', { className: 'verdict-body' }, [
    el('ul', {}, result.evidence.map((line) => el('li', {}, line))),
    el('dl', { className: 'verdict-facts' }, [
      fact('On-chain trace', result.onChainTrace),
      fact('Gas spent', result.gasSpent ? 'Yes' : 'No'),
      fact('Certain', result.certain ? 'Yes' : 'No, this is an inference'),
      fact('Source', source),
    ]),
  ]);

  if (needsAction(result.outcome)) {
    body.append(el('div', { className: 'remedy' }, remedy(result.outcome)));
  }

  slot.append(
    el('div', { className: 'verdict' }, [
      el('div', { className: 'verdict-head' }, [
        el('span', { className: 'verdict-name' }, result.label),
        el('span', { className: `pill ${result.tone}` }, result.outcome),
      ]),
      body,
    ]),
  );
}

async function classifyHash(hash) {
  const trimmed = hash.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    $('#verdict').replaceChildren(
      el('div', { className: 'verdict' }, [
        el('div', { className: 'verdict-head' }, [el('span', { className: 'verdict-name' }, 'Not a transaction hash')]),
        el('div', { className: 'verdict-body' }, [
          el('ul', {}, [
            el('li', {}, 'A transaction hash is 0x followed by 64 hex characters.'),
          ]),
        ]),
      ]),
    );
    return;
  }

  let receipt = null;
  let known = null;

  try {
    receipt = await rpcCall('eth_getTransactionReceipt', [trimmed]);
    if (!receipt) known = await rpcCall('eth_getTransactionByHash', [trimmed]);
  } catch (error) {
    $('#verdict').replaceChildren(
      el('div', { className: 'verdict' }, [
        el('div', { className: 'verdict-head' }, [el('span', { className: 'verdict-name' }, 'Could not reach the chain')]),
        el('div', { className: 'verdict-body' }, [
          el('ul', {}, [
            el('li', {}, error.message),
            el('li', {}, 'Many public RPC endpoints refuse cross-origin browser requests. Run the console locally with `npm run serve` and it will work, or point it at a custom RPC that allows CORS.'),
          ]),
        ]),
      ]),
    );
    return;
  }

  // Ask the chain's own registry first. A hash the compliance filter refused through the delayed
  // inbox is listed at 0x74, which turns "failed, reason unknown" into a certain answer.
  let filtered = false;
  try {
    filtered = decodeBool(await rpcCall('eth_call', [isFilteredCall(trimmed), 'latest']));
  } catch {
    filtered = false; // older chains have no such precompile; fall through to the receipt
  }
  if (filtered) {
    const v = filteredVerdict({ included: Boolean(receipt), gasUsed: receipt ? Number.parseInt(receipt.gasUsed, 16) : 0 });
    renderVerdict(v, 'live RPC and the 0x74 registry');
    return;
  }

  const result = classify({
    submission: { accepted: true, error: null },
    receipt: receipt ? { status: receipt.status === '0x1' ? 'success' : 'failure' } : null,
    blocksSinceSubmission: receipt ? 0 : FORCE_INCLUSION_WINDOW_BLOCKS + 1,
    windowBlocks: FORCE_INCLUSION_WINDOW_BLOCKS,
  });

  // A hash the node has never seen is the honest centre of this product. From outside, a screened
  // transaction and a hash that was never submitted are the same thing.
  const evidence = receipt
    ? result.evidence
    : [
        known
          ? 'The node knows this transaction but has not included it yet.'
          : 'The node has no record of this transaction at all.',
        'This is exactly what a screened transaction looks like from outside. It is also exactly what a hash that was never submitted looks like. Nothing available to you can tell the two apart, and that ambiguity is the problem this project exists to solve.',
      ];

  renderVerdict({ ...result, evidence }, 'live RPC');
}

const PRESETS = {
  screened: {
    label: 'A screened transfer',
    observation: {
      submission: { accepted: false, error: 'Transaction rejected by chain policy' },
      receipt: null,
      blocksSinceSubmission: 0,
      windowBlocks: FORCE_INCLUSION_WINDOW_BLOCKS,
    },
  },
  settled: {
    label: 'A settled transfer',
    observation: {
      submission: { accepted: true, error: null },
      receipt: { status: 'success' },
      blocksSinceSubmission: 1,
      windowBlocks: FORCE_INCLUSION_WINDOW_BLOCKS,
    },
  },
  pending: {
    label: 'Inside the window',
    observation: {
      submission: { accepted: true, error: null },
      receipt: null,
      blocksSinceSubmission: 40,
      windowBlocks: FORCE_INCLUSION_WINDOW_BLOCKS,
    },
  },
  'no-trace': {
    label: 'Past the window, no trace',
    observation: {
      submission: { accepted: true, error: null },
      receipt: null,
      blocksSinceSubmission: FORCE_INCLUSION_WINDOW_BLOCKS + 1,
      windowBlocks: FORCE_INCLUSION_WINDOW_BLOCKS,
    },
  },
};

/* -------------------------------------------------------------- recovery UI */

function renderRecovery() {
  const stranded = state.settlements.find(
    (s) => s.route === 'Bridge deposit' && s.outcome === OUTCOME.NO_TRACE,
  );
  if (!stranded) return;

  $('#recovery-body').append(
    el('div', { className: 'bridge' }, [
      el('h3', {}, `${stranded.ref} · ${stranded.amount} ${stranded.asset} stranded`),
      el('p', {}, stranded.note),
      el('div', { className: 'bridge-actions' }, [
        (() => {
          const button = el('button', { type: 'button', className: 'primary' }, 'Show the evidence');
          button.addEventListener('click', () => selectSettlement(stranded.ref));
          return button;
        })(),
        el('button', { type: 'button' }, 'Read the Arbitrum note on bridge deposits'),
      ]),
    ]),
  );

  const link = $('#recovery-body .bridge-actions button:last-child');
  link.addEventListener('click', () => {
    window.open(
      'https://docs.arbitrum.io/launch-arbitrum-chain/configure-your-chain/advanced/compliance-filtering',
      '_blank',
      'noopener',
    );
  });
}

/* ------------------------------------------------------------------- assets */

/**
 * Render the settlement asset registry, and check every entry against the chain as it renders.
 *
 * The rows go up first from the registry, each marked "checking", and are corrected in place as the
 * reads come back. That ordering is deliberate: a page that shows nothing until the network answers
 * looks broken on a slow RPC, and a page that shows a tick before it has looked is worse than broken.
 */
async function renderAssets() {
  const host = $('#assets');
  host.replaceChildren();

  let chainId = TESTNET;
  try {
    chainId = Number.parseInt(await rpcCall('eth_chainId'), 16);
  } catch {
    // Unreachable from the browser is normal for many public RPCs, which refuse cross-origin
    // requests. The registry still renders, and every row says it was not checked.
    chainId = TESTNET;
  }

  const assets = allAssets(chainId);
  const explorer = EXPLORER[chainId];

  host.append(
    el('div', { className: 'assets-head' }, [
      el('div', {}, 'Asset'),
      el('div', {}, 'Contract'),
      el('div', {}, 'Decimals'),
      el('div', {}, 'Checked against the chain'),
    ]),
  );

  for (const asset of assets) {
    const verdict = el('span', { className: 'pill warn' }, 'checking');

    const row = el('div', { className: `assets-row${asset.leg === 'cash' ? ' cash' : ''}` }, [
      el('div', { className: 'asset-name' }, [
        el('strong', {}, asset.symbol),
        el('span', { className: `leg ${asset.leg}` }, asset.leg === 'cash' ? 'cash leg' : 'asset leg'),
        el('span', { className: 'asset-full' }, asset.name),
      ]),
      el(
        'div',
        { className: 'asset-addr' },
        explorer
          ? [el('a', { href: `${explorer}/address/${asset.address}`, target: '_blank', rel: 'noopener' },
              el('code', {}, asset.address))]
          : [el('code', {}, asset.address)],
      ),
      el('div', { className: 'asset-decimals' }, String(asset.decimals)),
      el('div', { className: 'asset-verdict' }, [verdict]),
    ]);

    host.append(row);

    verifyAsset(rpcCall, asset).then((result) => {
      verdict.className = `pill ${result.checked && result.matches ? 'good' : result.checked ? 'bad' : 'warn'}`;

      if (!result.checked) {
        verdict.textContent = 'not checked';
        verdict.title = `The chain could not be reached from this page: ${result.reason}`;
      } else if (result.matches) {
        verdict.textContent = `matches: ${result.onChain.symbol}, ${result.onChain.decimals} decimals`;
      } else {
        verdict.textContent = 'does not match';
        verdict.title = result.mismatches.join('; ');
      }
    });
  }

  host.append(
    el('p', { className: 'assets-note' }, [
      `Read from ${CHAIN_NAMES[chainId] ?? `chain ${chainId}`} when this page loaded. `,
      'A hand-written address is a claim. The point of the column on the right is to show whether the claim survives contact with the chain, and to say so when the check could not run at all.',
    ]),
  );
}

/* ------------------------------------------------------------- live orders */

// The orders live on testnet whatever the RPC selector says, so this panel always asks testnet.
const TESTNET_RPC = 'https://rpc.testnet.chain.robinhood.com';

async function testnetCall(call) {
  const response = await fetch(TESTNET_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [call, 'latest'] }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from the RPC`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || 'RPC error');
  return body.result;
}

const fmtLeft = (secs) => {
  if (secs <= 0) return 'window closed';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s left`;
};

function txLink(name, hash) {
  return el('a', { href: `${EXPLORER[TESTNET]}/tx/${hash}`, target: '_blank', rel: 'noopener' }, `${name} ${hash.slice(0, 10)}…`);
}

function renderOrders() {
  const host = $('#orders');
  host.replaceChildren();

  for (const order of LIVE_ORDERS) {
    const status = el('span', { className: 'pill warn' }, 'reading the chain');
    const steps = el('ol', { className: 'steps' });
    const card = el('div', { className: 'order reveal in' }, [
      el('div', { className: 'order-top' }, [el('strong', {}, order.label), status]),
      el('p', { className: 'order-story' }, order.story),
      steps,
    ]);
    host.append(card);

    testnetCall(describeCall(order.ref))
      .then(decodeDescribe)
      .then((o) => {
        const usdg = Number(o.amount) / 1e6;
        const good = o.status === 'Settled' || o.status === 'Unwound';
        status.className = `pill ${good ? 'good' : 'warn'}`;
        status.textContent = `on chain: ${o.status}`;
        card.querySelector('.order-top').append(el('span', { className: 'order-amount sr-only' }, `${usdg} USDG`));

        const opened = order.txs.find(([n]) => n === 'open');
        const li = (cls, title, rest) => el('li', { className: cls }, [el('b', {}, title), ...(rest || [])]);
        steps.append(li('done', `Opened, ${usdg} USDG in escrow. `, [txLink('open', opened[1])]));

        if (o.status === 'Settled') {
          const settle = order.txs.find(([n]) => n === 'settle');
          steps.append(li('done', 'Settled to the counterparty. ', settle ? [txLink('settle', settle[1])] : []));
          const held = el('span', { className: 'live-val' }, 'reading');
          steps.append(li('done', 'The counterparty holds it now: ', [held]));
          const bal = '0x70a08231' + o.beneficiary.slice(2).padStart(64, '0'); // balanceOf(address)
          testnetCall({ to: o.token, data: bal })
            .then((hex) => { held.textContent = `${Number(BigInt(hex)) / 1e6} USDG, read live from the token.`; })
            .catch(() => { held.textContent = 'could not read the balance from this page.'; });
          return;
        }

        const openedAt = o.deadline - 86400 - 600; // the demo script adds a ten minute margin
        const bar = el('i');
        const left = el('span', { className: 'countdown' }, '');
        const windowLi = li(o.status === 'Open' && !o.unwindable ? 'now' : 'done', 'The 24 hour window. ', [
          el('span', {}, 'Nobody can unwind it yet, and the contract refuses anyone who tries.'),
          el('div', { className: 'window-bar' }, [bar]),
          el('div', { className: 'window-meta' }, [el('span', {}, `unwindable from ${new Date(o.deadline * 1000).toUTCString().slice(17, 22)} UTC`), left]),
        ]);
        steps.append(windowLi);

        const unwindTx = order.txs.find(([n]) => n === 'unwind');
        if (o.status === 'Unwound') {
          steps.append(li('done', 'Unwound by a wallet that never touched the order. The USDG went to the recovery address. ', unwindTx ? [txLink('unwind', unwindTx[1])] : []));
        } else {
          steps.append(li(o.unwindable ? 'now' : '', o.unwindable ? 'Open to anyone. Any wallet can unwind it now.' : 'Then anyone can unwind it, and the USDG goes to the recovery address.'));
        }

        const update = () => {
          const now = Date.now() / 1000;
          const frac = Math.min(1, Math.max(0, (now - openedAt) / (o.deadline - openedAt)));
          bar.style.width = `${(frac * 100).toFixed(2)}%`;
          left.textContent = o.status === 'Unwound' ? 'window closed' : fmtLeft(o.deadline - now);
          setWindowProgress(frac, o.status === 'Unwound' ? 'order 2 unwound after it' : `order 2: ${Math.round(frac * 100)}% of its window gone`);
        };
        update();
        setInterval(update, 1000);
      })
      .catch((error) => {
        status.className = 'pill warn';
        status.textContent = 'not checked';
        status.title = `The chain could not be reached from this page: ${error.message}`;
      });
  }
}

/* -------------------------------------------------------------------- watch */

let originalReceipt = null;

function renderReceipt(receipt) {
  const fields = $('#receipt-fields');
  const short = (v) => (v && v.length > 26 ? `${v.slice(0, 14)}…${v.slice(-8)}` : v);
  fields.replaceChildren(
    fact('Outcome', receipt.outcome === 'rejected' ? 'Refused by the RPC' : 'Accepted'),
    fact('What the RPC said', receipt.error ? `${receipt.error.code} ${receipt.error.message}` : receipt.result),
    fact('Transaction hash', short(receipt.txHash), 'mono'),
    fact('Observed', receipt.observedAt),
    fact('On chain', receipt.onChainTrace),
    fact('Watcher key (Ed25519)', short(receipt.watcher?.publicKey), 'mono'),
  );
}

async function checkReceipt(receipt) {
  const list = $('#receipt-checks');
  list.replaceChildren(el('li', {}, [el('span', { className: 'pill warn' }, 'checking')]));
  try {
    const { checks } = await verifyReceipt(receipt);
    list.replaceChildren(...checks.map((c) => el('li', {}, [
      el('span', { className: `pill ${c.ok ? 'good' : 'bad'}` }, c.ok ? 'passes' : 'fails'),
      el('b', {}, ` ${c.name}. `),
      el('span', {}, c.detail),
    ])));
  } catch (error) {
    list.replaceChildren(el('li', {}, `This browser could not run the check: ${error.message}. Ed25519 in WebCrypto needs a current browser.`));
  }
}

async function renderWatch() {
  if (!$('#watch')) return;
  try {
    originalReceipt = await (await fetch('./data/sample-receipt.json')).json();
  } catch {
    $('#receipt-checks').replaceChildren(el('li', {}, 'The sample receipt did not load.'));
    return;
  }
  const show = (r) => { renderReceipt(r); checkReceipt(r); };
  show(originalReceipt);

  $('#tamper').addEventListener('click', () => {
    // Change one word of what the RPC said, as someone rewriting the record would.
    const forged = structuredClone(originalReceipt);
    forged.error = { ...forged.error, message: 'transaction accepted' };
    show(forged);
  });
  $('#restore').addEventListener('click', () => show(originalReceipt));
  $('#verify-pasted').addEventListener('click', () => {
    try {
      show(JSON.parse($('#receipt-input').value));
    } catch (error) {
      $('#receipt-checks').replaceChildren(el('li', {}, `That is not valid JSON: ${error.message}`));
    }
  });
}

/* ------------------------------------------------------------------- wiring */

async function main() {
  try {
    await loadLedger();
  } catch (error) {
    $('#ledger').replaceChildren(
      el('p', { style: 'color:#6e6a62;font-size:14.5px' },
        `The ledger did not load (${error.message}). Serve this folder over HTTP rather than opening the file directly.`),
    );
  }

  renderLedger();
  startMotion();
  renderOrders();
  renderWatch();
  renderRecovery();
  probeNetwork();
  renderAssets();

  $('#classify-form').addEventListener('submit', (event) => {
    event.preventDefault();
    classifyHash($('#txhash').value);
  });

  $('#presets').addEventListener('click', (event) => {
    const live = event.target.closest('button[data-live]');
    if (live) {
      // Live presets ask the chain their example lives on: testnet for the orders, mainnet for the filtered transfer.
      $('#rpc').value = live.dataset.net || 'https://rpc.testnet.chain.robinhood.com';
      state.rpc = $('#rpc').value;
      $('#txhash').value = live.dataset.live;
      classifyHash(live.dataset.live);
      return;
    }
    const button = event.target.closest('button[data-case]');
    if (!button) return;
    const preset = PRESETS[button.dataset.case];
    renderVerdict(classify(preset.observation), 'worked example');
  });

  $('#rpc').addEventListener('change', (event) => {
    if (event.target.value === 'custom') {
      const url = window.prompt('RPC endpoint URL');
      if (url) {
        state.rpc = url.trim();
      } else {
        event.target.value = 'https://rpc.testnet.chain.robinhood.com';
        state.rpc = event.target.value;
      }
    } else {
      state.rpc = event.target.value;
    }
    probeNetwork();
  });

  // Open on the case that matters, so the page does not land on a settled row.
  const screened = state.settlements.find((s) => s.outcome === OUTCOME.SCREENED);
  if (screened) selectSettlement(screened.ref, false);
}

main();
