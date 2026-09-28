/**
 * Nullfill settlement console.
 *
 * Two jobs. First, replay a recorded scenario so the console can be read without a wallet. Second,
 * classify a real transaction hash against a live RPC, using the same pure classifier the command
 * line monitor uses.
 */

import { OUTCOME, classify, needsAction, remedy } from './lib/outcome.js';
import { CHAIN_NAMES, TESTNET, allAssets, verifyAsset } from './lib/assets.js';

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

function selectSettlement(ref) {
  state.selected = ref;
  const settlement = state.settlements.find((s) => s.ref === ref);
  renderLedger();
  renderDetail(settlement);
  $('#detail-panel').hidden = false;
  $('#detail-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
  renderRecovery();
  probeNetwork();
  renderAssets();

  $('#classify-form').addEventListener('submit', (event) => {
    event.preventDefault();
    classifyHash($('#txhash').value);
  });

  $('#presets').addEventListener('click', (event) => {
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
  if (screened) selectSettlement(screened.ref);
}

main();
