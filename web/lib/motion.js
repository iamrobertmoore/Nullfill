/**
 * Motion for the console. Every loop here carries information:
 *  - the dial launches transactions at a 24 hour ring; one lands, one reverts, and one disappears
 *    through the gap, which is all a screened transaction leaves on chain;
 *  - the outer arc is how much of order 2's real 24 hour window has passed;
 *  - the block number in the hero is Robinhood Chain testnet's, read live.
 * Nothing moves for a reader who has asked for reduced motion.
 */

const SVG = 'http://www.w3.org/2000/svg';
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const C = 300; // dial centre
const RING = 214;
const GAP_CENTRE = 272; // degrees, SVG convention: 270 is straight up
const TESTNET_RPC = 'https://rpc.testnet.chain.robinhood.com';

const polar = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
};

function node(tag, attrs, parent) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
}

/* ------------------------------------------------------------------ dial */

function drawTicks() {
  const g = document.getElementById('ticks');
  if (!g) return;
  for (let h = 0; h < 24; h++) {
    const deg = h * 15 - 90;
    const major = h % 6 === 0;
    const [x1, y1] = polar(major ? 244 : 248, deg);
    const [x2, y2] = polar(256, deg);
    node('line', { x1, y1, x2, y2, class: major ? 'major' : '' }, g);
  }
}

const FATES = [
  { kind: 'lands', colour: '#1f7a4d' },
  { kind: 'screened', colour: '#b23a2e' },
  { kind: 'reverts', colour: '#d49a2a' },
  { kind: 'lands', colour: '#1f7a4d' },
];

function launch(shots, fate) {
  const screened = fate.kind === 'screened';
  // Keep ordinary shots well away from the gap so the difference reads at a glance.
  const deg = screened ? GAP_CENTRE : (GAP_CENTRE + 60 + Math.random() * 240) % 360;
  const trail = node('line', { stroke: fate.colour, 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0.35 }, shots);
  const dot = node('circle', { r: 7, fill: '#16443c' }, shots);
  const start = performance.now();
  const travel = 1100;
  const endR = screened ? 300 : RING;

  function step(now) {
    const t = Math.min(1, (now - start) / travel);
    const e = 1 - Math.pow(1 - t, 3);
    const r = 122 + (endR - 122) * e;
    const [x, y] = polar(r, deg);
    const [tx, ty] = polar(Math.max(122, r - 70), deg);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    trail.setAttribute('x1', tx); trail.setAttribute('y1', ty);
    trail.setAttribute('x2', x); trail.setAttribute('y2', y);
    if (screened && r > RING - 10) {
      // Through the gap: it fades to nothing. No ripple, no mark, no receipt.
      const fade = Math.max(0, 1 - (r - (RING - 10)) / 70);
      dot.setAttribute('opacity', fade);
      dot.setAttribute('fill', '#b23a2e');
      trail.setAttribute('opacity', 0.35 * fade);
    }
    if (t < 1) return requestAnimationFrame(step);
    if (!screened) ripple(shots, x, y, fate.colour);
    else pulseZero();
    dot.remove();
    trail.remove();
  }
  requestAnimationFrame(step);
}

function ripple(parent, x, y, colour) {
  const c = node('circle', { cx: x, cy: y, r: 6, fill: 'none', stroke: colour, 'stroke-width': 3 }, parent);
  const mark = node('circle', { cx: x, cy: y, r: 5, fill: colour }, parent);
  const start = performance.now();
  (function grow(now) {
    const t = Math.min(1, (now - start) / 900);
    c.setAttribute('r', 6 + 26 * t);
    c.setAttribute('opacity', 1 - t);
    mark.setAttribute('opacity', 1 - t * 0.9);
    if (t < 1) requestAnimationFrame(grow); else { c.remove(); mark.remove(); }
  })(start);
}

function pulseZero() {
  const big = document.querySelector('.dial-big');
  if (!big) return;
  big.animate([{ fill: '#b23a2e', transform: 'scale(1.06)' }, { fill: '#111512', transform: 'scale(1)' }], {
    duration: 900, easing: 'cubic-bezier(.2,.7,.2,1)',
  });
  big.style.transformOrigin = '300px 318px';
}

function runDial() {
  const shots = document.getElementById('shots');
  const dial = document.getElementById('dial');
  if (!shots || !dial) return;
  drawTicks();
  if (reduced()) return;

  let i = 0;
  let timer = null;
  const tick = () => { launch(shots, FATES[i++ % FATES.length]); };
  const start = () => { if (!timer) { tick(); timer = setInterval(tick, 1700); } };
  const stop = () => { clearInterval(timer); timer = null; };

  new IntersectionObserver((entries) => {
    entries[0].isIntersecting && !document.hidden ? start() : stop();
  }).observe(dial);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
}

/** The outer arc: how much of a real escrow's 24 hour window has gone. */
export function setWindowProgress(fraction, label) {
  const arc = document.getElementById('progress');
  if (!arc) return;
  const circ = 2 * Math.PI * 238;
  const f = Math.max(0, Math.min(1, fraction));
  arc.setAttribute('stroke-dasharray', `${(f * circ).toFixed(1)} ${circ.toFixed(1)}`);
  const small = document.querySelector('.f4 small');
  if (small && label) small.textContent = label;
}

/* ------------------------------------------------------------ live block */

async function blockNumber() {
  const res = await fetch(TESTNET_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return Number.parseInt(body.result, 16);
}

function runBlockTicker() {
  const out = document.getElementById('hero-block');
  if (!out) return;
  let last = 0;
  const read = async () => {
    try {
      const n = await blockNumber();
      if (n !== last) {
        out.textContent = n.toLocaleString('en-GB');
        if (last && !reduced()) out.animate([{ color: '#1f7a4d' }, { color: 'inherit' }], { duration: 700 });
        last = n;
      }
    } catch {
      if (!last) out.textContent = 'not reachable';
    }
  };
  read();
  setInterval(() => { if (!document.hidden) read(); }, 2500);
}

/* --------------------------------------------------------- reveal, counts */

function countUp(el) {
  const to = Number.parseFloat(el.dataset.to);
  const dec = Number.parseInt(el.dataset.dec || '0', 10);
  if (reduced() || !Number.isFinite(to) || to === 0) { el.textContent = to.toFixed(dec); return; }
  const start = performance.now();
  const dur = 1500;
  (function frame(now) {
    const t = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - t, 4);
    el.textContent = Number((to * e).toFixed(dec)).toLocaleString("en-GB", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    if (t < 1) requestAnimationFrame(frame); else el.textContent = to.toLocaleString("en-GB", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  })(start);
}

function runReveal() {
  const items = document.querySelectorAll('.reveal');
  if (reduced() || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      entry.target.querySelectorAll('.count').forEach(countUp);
      if (entry.target.classList.contains('count')) countUp(entry.target);
      io.unobserve(entry.target);
    }
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  items.forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i % 4, 3) * 70}ms`;
    io.observe(el);
  });
}

export function startMotion() {
  document.documentElement.classList.remove('no-js');
  runReveal();
  runDial();
  runBlockTicker();
}
