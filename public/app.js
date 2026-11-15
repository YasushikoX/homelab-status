// Status dashboard client. Vanilla JS, no build step.
// Renders HTML strings, then *patches* the live DOM (morph) instead of
// replacing it, so bars/rings glide to new values, numbers count, hover and
// typed state survive the 10-second refresh, and new items animate in.
'use strict';

try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* storage blocked */ }
{ const t = new URLSearchParams(location.search).get('theme'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; } // the wall passes its own theme

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

let STATE = null;
let firstPaint = true;
const VIEW = ({ '/sites': 'sites', '/maps': 'maps' })[location.pathname.replace(/\/$/, '')] || 'overview';
document.body.classList.add(`view-${VIEW}`);
// ?embed=1: a map shown inside the /wall screen: no chrome, polled at the wall's pace
const EMBED = new URLSearchParams(location.search).has('embed');
if (EMBED) document.body.classList.add('embed');
document.getElementById(`nav-${VIEW}`)?.setAttribute('aria-current', 'page');
let svcFilter = 'all';
let showAcked = false;
let showStopped = false;
let drawer = { machine: null, tab: 'overview', job: null };
let pkgFilter = '';
let drawerOpener = null;
let jobPoll = null;
const watchedJobs = new Map(); // jobId -> last known status (for completion toasts)

// ============================================================ formatting
function fmtBytes(b) {
  if (b == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtDur(s) {
  if (s == null) return '–';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function ago(t) {
  if (!t) return 'never';
  const s = (Date.now() - (typeof t === 'number' ? t : Date.parse(t))) / 1000;
  if (s < 0 || isNaN(s)) return '–';
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtIn(t) {
  const s = Math.max(0, (t - Date.now()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  const d = Math.floor(s / 86400), h = Math.round((s % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}
function fmtResetAt(t) {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ============================================================ icons
const STATUS_ICONS = {
  ok: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M4.7 8.3l2.2 2.2 4.4-4.7" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7.1 1.9a1 1 0 0 1 1.8 0l6.3 11.3a1 1 0 0 1-.9 1.5H1.7a1 1 0 0 1-.9-1.5z" fill="currentColor"/><path d="M8 6v3.4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.8" r=".95" fill="#fff"/></svg>',
  down: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  off: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 8h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  unknown: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2.2"/></svg>',
  ack: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};
const LABELS = { ok: 'OK', warn: 'Attention', down: 'Down', off: 'Stopped', unknown: 'Checking', ack: 'Acknowledged' };
const MACHINE_LABELS = { ok: 'Online', warn: 'Attention', down: 'Down', off: 'Off', unknown: 'Updating…', ack: 'Acknowledged' };
const badge = (st, labels = LABELS) => `<span class="status ${esc(st)}">${STATUS_ICONS[st] || STATUS_ICONS.unknown}<span class="lbl">${esc(labels[st] || st)}</span></span>`;

const SYM = {
  server: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="6.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="7.5" cy="7.25" r="1.1" fill="currentColor"/><circle cx="7.5" cy="16.75" r="1.1" fill="currentColor"/></svg>',
  laptop: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="10" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M2.5 18.5h19" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  desktop: '<svg viewBox="0 0 24 24"><rect x="5.5" y="5.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.5 20.5h7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  gamepad: '<svg viewBox="0 0 24 24"><path d="M7 8h10a4.5 4.5 0 0 1 4.3 5.8l-.9 3a2.4 2.4 0 0 1-4.2.8L14.5 16h-5l-1.7 1.6a2.4 2.4 0 0 1-4.2-.8l-.9-3A4.5 4.5 0 0 1 7 8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8 11v3M6.5 12.5h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="15.5" cy="11.5" r="1" fill="currentColor"/><circle cx="17.5" cy="13.5" r="1" fill="currentColor"/></svg>',
  route: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 12h17M12 3.5c2.6 2.5 3.8 5.3 3.8 8.5s-1.2 6-3.8 8.5c-2.6-2.5-3.8-5.3-3.8-8.5S9.4 6 12 3.5z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  checks: '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5.5c0 4.3-3 7.9-7 9.5-4-1.6-7-5.2-7-9.5V6z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M8.6 12.2l2.3 2.3 4.5-4.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  download: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 7.5v8m0 0l-3.4-3.4M12 15.5l3.4-3.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  failover: '<svg viewBox="0 0 24 24"><path d="M5 9h11.5l-3-3M19 15H7.5l3 3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  hide: '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  show: '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 16 16"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  stop: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="5.6" y="5.6" width="4.8" height="4.8" rx=".8" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.6 5.4v5.2L10.8 8z" fill="currentColor"/></svg>',
  terminal: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  power: '<svg viewBox="0 0 24 24"><path d="M12 3.5v7.5M7 6.5a7.5 7.5 0 1 0 10 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ext: '<svg viewBox="0 0 16 16"><path d="M9 3h4v4M13 3l-6 6M11.5 9.5V13H3V4.5h3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  hand: '<svg viewBox="0 0 24 24"><path d="M12 3.5v9M8.5 5.5v8M15.5 5.5v8M5.5 9v6.5a5.5 5.5 0 0 0 5.5 5.5h1.5a6 6 0 0 0 6-6V9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 16 16"><circle cx="8" cy="4.6" r="1.1" fill="currentColor"/><path d="M8 7.3v4.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
const machineIcon = (m) => SYM[m.icon] || SYM.desktop;

// ============================================================ DOM morphing
// Patches `root` to match `html`, reusing nodes (matched by data-key, else
// position + tag). Elements with data-anim keep their inline style (driven by
// applyAnim); elements with data-num count to their new value.
function morph(root, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  patchChildren(root, tpl.content);
  applyAnim(root);
}
const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-key') : null);

function patchChildren(a, b) {
  const want = Array.from(b.childNodes);
  const keyed = new Map();
  for (const n of a.childNodes) { const k = keyOf(n); if (k) keyed.set(k, n); }
  want.forEach((bn, i) => {
    const cur = a.childNodes[i] || null;
    const k = keyOf(bn);
    let match = null;
    if (k) match = keyed.get(k) || null;
    else if (cur && !keyOf(cur) && cur.nodeType === bn.nodeType && cur.nodeName === bn.nodeName) match = cur;
    if (!match) { a.insertBefore(bn, cur); onInsert(bn, i); return; }
    if (k) keyed.delete(k);
    if (match !== cur) a.insertBefore(match, cur);
    patchNode(match, bn);
  });
  while (a.childNodes.length > want.length) a.removeChild(a.lastChild);
}

function patchNode(a, b) {
  if (a.nodeType === 3 || a.nodeType === 8) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  if (a.hasAttribute('data-num')) {
    const from = parseFloat(a.getAttribute('data-num')), to = parseFloat(b.getAttribute('data-num'));
    patchAttrs(a, b);
    if (from !== to) countTo(a, from, to); else if (a.textContent !== b.textContent && !a._counting) a.textContent = b.textContent;
    return;
  }
  const oldStatus = a.getAttribute('data-status');
  patchAttrs(a, b);
  if (a.id === 'job-log' || a.hasAttribute('data-keep')) return; // managed elsewhere
  patchChildren(a, b);
  const newStatus = a.getAttribute('data-status');
  if (oldStatus && newStatus && oldStatus !== newStatus && !reduceMotion.matches) {
    a.classList.remove('flash'); void a.offsetWidth; a.classList.add('flash');
  }
}

const TRANSIENT = ['enter', 'flash', 'num-pop', 'leaving'];
function patchAttrs(a, b) {
  const keepStyle = a.hasAttribute('data-anim');
  // <details open> belongs to the user once rendered (unless the new render forces it)
  const userOpen = a.tagName === 'DETAILS' && !b.hasAttribute('data-force');
  for (const { name } of Array.from(a.attributes)) {
    if (!b.hasAttribute(name) && !(keepStyle && name === 'style') && !(userOpen && name === 'open')) a.removeAttribute(name);
  }
  for (const { name, value } of Array.from(b.attributes)) {
    if (keepStyle && name === 'style') continue;
    if (userOpen && name === 'open') continue;
    if (name === 'class') {
      const keep = TRANSIENT.filter((c) => a.classList.contains(c));
      const next = [value, ...keep].filter(Boolean).join(' ');
      if (a.getAttribute('class') !== next) a.setAttribute('class', next);
      continue;
    }
    if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  }
  // checkboxes: the attribute stops driving the visible state once clicked, so set the property
  if (a.tagName === 'INPUT' && a.type === 'checkbox' && document.activeElement !== a) a.checked = b.hasAttribute('checked');
}

function onInsert(n, i) {
  if (n.nodeType !== 1) return;
  if (n.hasAttribute('data-key') && !reduceMotion.matches) {
    n.classList.add('enter');
    n.style.setProperty('--i', String(Math.min(i, 14)));
    n.addEventListener('animationend', (e) => { if (e.target === n) n.classList.remove('enter'); }, { once: true });
  }
  const nums = n.matches('[data-num]') ? [n] : [];
  nums.push(...n.querySelectorAll('[data-num]'));
  for (const el of nums) if (el.hasAttribute('data-count-in')) countTo(el, 0, parseFloat(el.getAttribute('data-num')));
}

// meters (data-anim="w", data-to = percent) and rings (data-anim="ring", data-to = dashoffset)
function applyAnim(root) {
  const els = root.querySelectorAll('[data-anim]');
  if (!els.length) return;
  void root.offsetWidth; // commit initial styles of freshly inserted nodes so the change transitions
  requestAnimationFrame(() => {
    for (const el of els) {
      const to = el.getAttribute('data-to');
      if (el.dataset.anim === 'w') { if (el.style.width !== `${to}%`) el.style.width = `${to}%`; }
      else if (el.dataset.anim === 'ring') { if (el.style.strokeDashoffset !== `${to}`) el.style.strokeDashoffset = to; }
    }
  });
}

function countTo(el, from, to) {
  const fmt = el.getAttribute('data-fmt') || 'int';
  const show = (v) => { el.textContent = fmt === 'int' ? Math.round(v).toLocaleString() : v.toFixed(0); };
  if (reduceMotion.matches || !isFinite(from) || !isFinite(to)) { show(to); return; }
  const t0 = performance.now(), dur = 900;
  el._counting = true;
  el.classList.remove('num-pop'); void el.offsetWidth; el.classList.add('num-pop');
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    show(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step); else el._counting = false;
  };
  requestAnimationFrame(step);
}
const numSpan = (v, cls = '', countIn = true) => `<span class="${cls}" data-num="${Number(v) || 0}" data-fmt="int"${countIn ? ' data-count-in' : ''}>${Math.round(Number(v) || 0).toLocaleString()}</span>`;

// ============================================================ toasts, dialog, loading bar
function toast(text, kind = 'info', { sticky = false, ms = 3400, action } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  const ico = () => (kind === 'busy' ? '<span class="spinner"></span>' : kind === 'ok' ? SYM.check : kind === 'bad' ? SYM.x : SYM.info);
  const paint = () => {
    el.className = `toast ${kind}`;
    el.innerHTML = `<span class="t-ico">${ico()}</span><span class="t-text">${esc(text)}</span>${action ? `<button class="btn" type="button" style="padding:4px 12px;margin-left:4px">${esc(action.label)}</button>` : ''}`;
    if (action) el.querySelector('button').onclick = () => { action.run(); close(); };
  };
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 600);
  };
  const arm = () => { clearTimeout(timer); if (!sticky && kind !== 'busy') timer = setTimeout(close, ms); };
  paint();
  $('#toasts').appendChild(el);
  arm();
  return { update(t, k = kind) { text = t; kind = k; paint(); arm(); }, close };
}

function confirmDialog({ title, message, warn, confirmLabel = 'Update', risky = false }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'dialog-scrim';
    scrim.innerHTML = `<div class="dialog ${risky ? 'risky' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-m">
      <div class="d-icon">${SYM.download}</div>
      <h3 id="dlg-t">${esc(title)}</h3>
      <p id="dlg-m">${esc(message || '')}</p>
      ${warn ? `<div class="d-warn">${esc(warn)}</div>` : ''}
      <div class="d-actions">
        <button class="btn" type="button" data-r="0">Cancel</button>
        <button class="btn ${risky ? 'destructive' : 'primary'}" type="button" data-r="1">${esc(confirmLabel)}</button>
      </div></div>`;
    const done = (r) => {
      scrim.classList.add('out');
      setTimeout(() => scrim.remove(), 220);
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
      resolve(r);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Tab') { // keep focus inside the dialog
        const b = [...scrim.querySelectorAll('button')]; const i = b.indexOf(document.activeElement);
        e.preventDefault(); b[(i + (e.shiftKey ? -1 : 1) + b.length) % b.length].focus();
      }
    };
    scrim.addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) done(b.dataset.r === '1'); else if (e.target === scrim) done(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    scrim.querySelector(risky ? '[data-r="0"]' : '[data-r="1"]').focus();
  });
}

const loadbar = {
  start() { const l = $('#loadbar'); l.classList.remove('done'); l.querySelector('span').style.width = ''; void l.offsetWidth; l.classList.add('on'); },
  done() { const l = $('#loadbar'); if (!l.classList.contains('on')) return; l.classList.add('done'); setTimeout(() => l.classList.remove('on', 'done'), 450); },
};

// ============================================================ meters, rings, sparklines
function meter(label, used, total, valueText, key) {
  const p = total ? Math.max(0, Math.min(100, (100 * used) / total)) : (used ?? null);
  if (p == null || isNaN(p)) return '';
  const sev = p >= 90 ? 'sev-bad' : p >= 75 ? 'sev-warn' : '';
  return `<div class="meter-row" data-key="${esc(key || label)}"><span class="k">${esc(label)}</span>
    <div class="meter ${sev}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.toFixed(0)}" aria-label="${esc(`${label} ${p.toFixed(0)} percent${valueText ? `, ${valueText}` : ''}`)}"><span data-anim="w" data-to="${p.toFixed(1)}" style="width:0"></span></div>
    <span class="v">${esc(valueText || p.toFixed(0) + '%')}</span></div>`;
}

const RING_R = 31, RING_C = 2 * Math.PI * RING_R;
function ring(w, key) {
  const sev = w.left <= 0 ? 'sev-bad' : w.left <= 10 ? 'sev-warn' : '';
  const off = (RING_C * (1 - w.left / 100)).toFixed(2);
  const reset = w.resetsAt ? `${fmtResetAt(w.resetsAt)} · in ${fmtIn(w.resetsAt)}` : 'no reset time';
  return `<div class="ring-item" data-key="${esc(key)}" title="${esc(`${w.label}: ${w.left}% left (${w.used.toFixed(0)}% used). Resets ${reset}.`)}">
    <div class="ring ${sev}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${w.left.toFixed(0)}" aria-label="${esc(`${w.label}: ${w.left.toFixed(0)} percent left, resets ${reset}`)}">
      <svg viewBox="0 0 74 74" aria-hidden="true"><circle class="track" cx="37" cy="37" r="${RING_R}"/><circle class="arc" cx="37" cy="37" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" data-anim="ring" data-to="${off}" style="stroke-dashoffset:${RING_C.toFixed(2)}"/></svg>
      <div class="center"><div><span class="pct">${numSpan(w.left)}<small>%</small></span><span class="left-lbl">left</span></div></div>
    </div>
    <span class="k">${esc(w.label)}</span>
    <span class="reset">${esc(w.resetsAt ? `Resets ${fmtResetAt(w.resetsAt)}` : 'No reset time')}<br>${esc(w.resetsAt ? `in ${fmtIn(w.resetsAt)}` : '')}</span>
  </div>`;
}

const sparkData = new Map();
function sparkline(points, key, caption, id) {
  const pts = points.filter((p) => p[key] != null);
  if (pts.length < 2) return `<div class="spark" data-key="${id}"><div class="cap"><span>${esc(caption)}</span><span>collecting…</span></div><svg viewBox="0 0 100 36"></svg></div>`;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, W = 100, H = 31;
  const x = (t) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * W);
  const y = (v) => H - (Math.min(100, Math.max(0, v)) / 100) * (H - 3) - 1.5;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(2)},${y(p[key]).toFixed(2)}`).join('');
  const last = pts[pts.length - 1][key];
  sparkData.set(id, { pts, key, x, y, caption });
  return `<div class="spark" data-key="${id}"><div class="cap"><span>${esc(caption)}</span><span class="num">${last.toFixed(0)}% now</span></div>
    <svg id="${id}" viewBox="0 0 ${W} 36" preserveAspectRatio="none" role="img" aria-label="${esc(caption)}: ${last.toFixed(0)} percent now">
      <line class="base" x1="0" x2="${W}" y1="${H}" y2="${H}"/>
      <path class="area" d="${d}L${W},${H}L0,${H}Z"/><path class="line" d="${d}"/>
      <line class="xh" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>
    </svg></div>`;
}

function bindSparks(root) {
  root.querySelectorAll('.spark svg[id]').forEach((svg) => {
    if (svg._bound) return;
    svg._bound = true;
    const tip = $('#tooltip');
    let dot = null;
    svg.addEventListener('pointermove', (ev) => {
      const data = sparkData.get(svg.id); if (!data) return;
      const xh = svg.querySelector('.xh');
      const r = svg.getBoundingClientRect();
      const fx = ((ev.clientX - r.left) / r.width) * 100;
      let best = data.pts[0];
      for (const p of data.pts) if (Math.abs(data.x(p.t) - fx) < Math.abs(data.x(best.t) - fx)) best = p;
      const px = data.x(best.t), py = data.y(best[data.key]);
      xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
      if (!dot) { dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); dot.setAttribute('class', 'dot'); dot.setAttribute('r', '3.5'); svg.appendChild(dot); }
      dot.setAttribute('cx', px); dot.setAttribute('cy', py);
      tip.innerHTML = `<span class="t">${esc(clock(best.t))}</span> · <b>${best[data.key].toFixed(1)}%</b> ${esc(data.caption.split(' ')[0])}`;
      tip.hidden = false;
      tip.style.left = `${Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8)}px`;
      tip.style.top = `${ev.clientY - 40}px`;
    });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; svg.querySelector('.xh')?.setAttribute('visibility', 'hidden'); dot?.remove(); dot = null; });
    svg.addEventListener('click', (e) => e.stopPropagation());
  });
}

// ============================================================ acknowledgement helpers
const ackedKeys = () => new Set((STATE?.summary.acknowledged || []).map((p) => p.key));
const openProblemsFor = (machineId) => (STATE?.summary.problems || []).filter((p) => p.machine === machineId);
// A machine whose only problems are acknowledged shows a grey "Acknowledged" badge.
function displayStatus(m) {
  if ((m.status === 'warn' || m.status === 'down') && !openProblemsFor(m.id).length
      && (STATE.summary.acknowledged || []).some((p) => p.machine === m.id)) return 'ack';
  return m.status;
}

// ============================================================ render: header, hero, tiles
function renderHeader(s) {
  const inst = s.instance;
  const el = $('#instance');
  el.textContent = inst.demo ? 'Demo · simulated data' : inst.role === 'primary' ? `Primary · ${inst.host}`
    : inst.active ? `Backup · in charge since ${clock(inst.since)}` : `Backup · ${inst.host} · standby`;
  el.className = 'instance' + (inst.role === 'standby' && inst.active ? ' takeover' : '');
  const banner = $('#banner');
  if (inst.role === 'standby' && inst.active) {
    const last = inst.events.filter((e) => e.active).pop();
    morph(banner, `<div class="banner" data-key="takeover">${STATUS_ICONS.warn}<div><b>Running on the backup.</b> ${esc(last?.message || '')} The primary${inst.failover ? ` on ${esc(inst.failover.primary)}` : ''} takes back over automatically when it's healthy again.</div></div>`);
  } else if (inst.role === 'standby') {
    morph(banner, `<div class="banner" data-key="standby">${STATUS_ICONS.off}<div>This is the standby copy on ${esc(inst.host)}. The primary${inst.failover ? ` on ${esc(inst.failover.primary)}` : ''} is serving the dashboard; updates can only be started there.</div></div>`);
  } else morph(banner, '');
}

function renderHero(s) {
  const ps = s.summary.problems;
  const down = ps.filter((p) => p.status === 'down').length;
  const st = down ? 'down' : ps.length ? 'warn' : 'ok';
  const text = !ps.length ? 'All systems operational' : down ? `${plural(down, 'problem')} need${down === 1 ? 's' : ''} you${ps.length > down ? ` · ${ps.length - down} more to look at` : ''}` : `${plural(ps.length, 'thing')} to look at`;
  const acked = s.summary.acknowledged.length;
  morph($('#hero-sub'), `<span class="dot ${st}" data-status="${st}"></span><span>${esc(text)}</span>${acked ? `<span class="muted" style="font-size:14px">· ${acked} acknowledged</span>` : ''}`);
}

function renderTiles(s) {
  const sm = s.summary, peer = s.instance.peer;
  const machineSt = s.machines.some((m) => m.status === 'down') ? 'down' : s.machines.some((m) => m.status === 'unknown') ? 'unknown' : 'ok';
  const openDown = sm.problems.some((p) => p.status === 'down');
  const checkSt = !sm.problems.length ? 'ok' : openDown ? 'down' : 'warn';
  const fo = s.instance.failover;
  const backupState = !peer ? 'off' : s.instance.role === 'primary' ? (peer.healthy == null ? 'unknown' : peer.healthy ? 'ok' : 'down') : (s.instance.active ? 'warn' : 'ok');
  const backupText = !peer ? 'Single copy' : s.instance.role === 'primary' ? (peer.healthy == null ? 'Checking backup…' : peer.healthy ? 'Ready to take over' : 'Backup not responding') : (s.instance.active ? 'Backup is serving' : 'Standing by');
  morph($('#tiles'), `
    <div class="tile" data-key="t-machines"><div class="tile-top"><span class="label">Machines online</span></div>
      <div class="value">${numSpan(sm.machinesUp)}<span class="of"> / ${sm.machinesTotal}</span></div>
      <div class="sub">${badge(machineSt, { ...MACHINE_LABELS, ok: 'All reachable' })}</div></div>
    <div class="tile" data-key="t-checks"><div class="tile-top"><span class="label">Checks passing</span></div>
      <div class="value">${numSpan(sm.checksOk)}<span class="of"> / ${sm.checksTotal}</span></div>
      <div class="sub">${badge(checkSt, { ...LABELS, ok: sm.acknowledged.length ? 'Nothing new' : 'All good' })}<span>${sm.problems.length ? `${sm.problems.length} open` : ''}${sm.acknowledged.length ? `${sm.problems.length ? ' · ' : ''}${sm.acknowledged.length} acknowledged` : ''}</span></div></div>
    <div class="tile" data-key="t-updates"><div class="tile-top"><span class="label">Updates available</span></div>
      <div class="value">${numSpan(sm.updates)}</div>
      <div class="sub">${sm.security ? `<span class="pill sec">${sm.security.toLocaleString()} security</span>` : '<span>none flagged security</span>'}</div></div>
    <div class="tile" data-key="t-failover"><div class="tile-top"><span class="label">Failover</span></div>
      <div class="value text">${esc(backupText)}</div>
      <div class="sub">${badge(backupState, !peer ? { ...LABELS, off: 'Not set up' } : LABELS)}<span>${esc(!fo ? 'no backup copy configured' : s.instance.role === 'primary' ? `backup on ${fo.backup}` : `primary on ${fo.primary}`)}</span></div></div>`);
}

// ============================================================ render: problems + acknowledgements
const stopBtn = (key, name) => `<button class="ack-btn" type="button" data-stop="${esc(key)}" data-name="${esc(name)}" title="I turned this off: show it grey as Stopped until it's running again">${SYM.stop}<span>Stopped on purpose</span></button>`;
const unstopBtn = (key, name) => `<button class="ack-btn" type="button" data-unstop="${esc(key)}" data-name="${esc(name)}" title="Treat it as down (red) again">${SYM.play}<span>Expect running</span></button>`;

function problemRow(p, acked) {
  const where = STATE.machines.find((m) => m.id === p.machine)?.name || '';
  const actions = acked
    ? `<button class="ack-btn" type="button" data-unack="${esc(p.key)}" title="Show this in Needs attention again">${SYM.show}<span>Show again</span></button>`
    : `${p.status === 'down' && p.kind !== 'self' && p.kind !== 'quota' ? stopBtn(p.key, p.name) : ''}<button class="ack-btn" type="button" data-ack="${esc(p.key)}" data-name="${esc(p.name)}" title="Hide until it changes">${SYM.hide}<span>Hide</span></button>`;
  return `<div class="problem" data-key="${esc(p.key)}" data-status="${esc(p.status)}">${badge(acked ? 'ack' : p.status)}<b>${esc(p.name)}</b><span class="detail">${esc(p.detail)}</span><span class="where muted small">${esc(where)}</span>
    <span class="p-actions">${actions}</span></div>`;
}
function stoppedRow(p) {
  const where = STATE.machines.find((m) => m.id === p.machine)?.name || '';
  return `<div class="problem" data-key="st-${esc(p.key)}" data-status="off">${badge('off')}<b>${esc(p.name)}</b><span class="detail">${esc(p.at ? `Marked ${ago(p.at)} · goes back to normal when it's running again` : p.detail)}</span><span class="where muted small">${esc(where)}</span>
    <span class="p-actions">${unstopBtn(p.key, p.name)}</span></div>`;
}

function renderProblems(s) {
  const ps = [...s.summary.problems].sort((a, b) => ({ down: 0, warn: 1 }[a.status] - { down: 0, warn: 1 }[b.status]));
  // hidden / stopped-on-purpose items are not listed here; undo them from Recent activity
  const ackSection = '';
  if (!ps.length) {
    morph($('#problems'), `<div class="problems" data-key="problems-ok"><div class="all-good">
      <svg viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="12" fill="currentColor" opacity=".16"/><path class="check-path" d="M8 13.5l3.3 3.3L18.5 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>Nothing needs your attention.</span></div>${ackSection}</div>`);
    return;
  }
  morph($('#problems'), `<div class="problems" data-key="problems-list"><div class="problems-head"><h2 style="font-size:17px">Needs attention</h2><span class="count">${ps.length}</span>
      ${ps.length > 1 ? `<button class="ack-btn ack-all" type="button" data-ack="*" data-name="everything listed">${SYM.hide}<span>Hide all</span></button>` : ''}</div>
    ${ps.map((p) => problemRow(p, false)).join('')}${ackSection}</div>`);
}

// ============================================================ render: AI quota
// Badges stay short so the provider name and account keep their room; the long explanation goes on its own line.
const QUOTA_LABELS = { ok: 'Available', warn: 'Low', down: 'At limit', off: 'Paused', unknown: 'No data', ack: 'Hidden' };
function quotaShort(a) {
  const w5 = a.windows.find((w) => w.label === '5-hour') || a.lowest;
  if (a.status === 'off') return w5?.resetsAt ? `Paused until ${fmtResetAt(w5.resetsAt)}` : 'Paused';
  if (a.status === 'down') return a.lowest?.resetsAt ? `At limit until ${fmtResetAt(a.lowest.resetsAt)}` : 'At limit';
  if (a.status === 'warn' && a.cooling?.length) {
    const c = a.cooling[0];
    return `Cooling down: ${c.model || 'account'}${c.until ? ` until ${fmtResetAt(c.until)}` : ''}${a.cooling.length > 1 ? ` (+${a.cooling.length - 1})` : ''}`;
  }
  if (a.status === 'warn') return a.lowest ? `${a.lowest.label} ${a.lowest.left.toFixed(0)}% left` : 'Low';
  return '';
}
function quotaNote(a) {
  if (a.status === 'ok' || a.status === 'unknown') return '';
  const w5 = a.windows.find((w) => w.label === '5-hour') || a.lowest;
  const when = w5?.resetsAt ? `${fmtResetAt(w5.resetsAt)} (in ${fmtIn(w5.resetsAt)})` : null;
  if (a.status === 'off') return a.preferred ? `Paused by the quota guard · back after the ${w5?.label || ''} reset${when ? ` at ${when}` : ''}` : 'Disabled in the hub';
  if (a.status === 'down') return `${a.statusLabel}${a.lowest?.resetsAt ? ` · resets ${fmtResetAt(a.lowest.resetsAt)}` : ''}`;
  return `${a.statusLabel}${a.lowest ? ` · ${a.lowest.label} ${a.lowest.left.toFixed(0)}% left` : ''}`;
}
function renderQuota(s) {
  const q = s.quota;
  $('#quota-section').hidden = q.enabled === false; // no machine collects quota (reporterConfig.hub_quota)
  $('#quota-meta').textContent = q.fetchedAt ? `Live from the CLIProxyAPI hub · updated ${ago(q.fetchedAt)}${q.stale ? ' · stale' : ''}` : '';
  if (!q.accounts.length) { morph($('#quota'), `<div class="qcard" data-key="q-empty"><div class="muted">${esc(q.error || 'No quota data yet.')}</div></div>`); return; }
  const acked = ackedKeys();
  morph($('#quota'), (q.error ? `<div class="banner" style="grid-column:1/-1" data-key="q-err">${STATUS_ICONS.warn}<div>${esc(q.error)}</div></div>` : '') + q.accounts.map((a) => {
    const st = (a.status === 'warn' || a.status === 'down') && acked.has(`quota:${a.provider}:${a.account}`) ? 'ack' : a.status;
    const tags = [a.plan ? `<span class="tag">${esc(a.plan)}</span>` : '', a.preferred ? '<span class="tag" title="Used first by the hub; your quota guard pauses it near its limit">preferred</span>' : ''].join('');
    const foot = [
      a.resetCredits ? plural(a.resetCredits, 'reset credit') : '',
      a.requests.ok != null ? `${a.requests.ok.toLocaleString()} requests · ${a.requests.failed} failed` : '',
    ].filter(Boolean).map(esc);
    const src = a.source === 'live' ? '<span class="src"><i></i>Live</span>' : a.source === 'headers' ? `<span class="src headers"><i></i>From last request${a.observedAt ? ` (${esc(ago(a.observedAt))})` : ''}</span>` : '';
    return `<div class="qcard ${a.status === 'off' ? 'off' : ''}" data-key="q-${esc(a.provider)}-${esc(a.account)}" data-status="${esc(st)}">
      <div class="q-head"><span class="avatar ${esc(a.provider)}">${esc(a.providerName[0])}</span>
        <div class="q-title"><span class="name" title="${esc(a.providerName)}"><span class="nm">${esc(a.providerName)}</span>${tags}</span><span class="meta" title="${esc(a.account)}">${esc(a.account)}</span></div>
        <span title="${esc([quotaNote(a) || a.statusLabel, a.unsupportedModels?.length ? `Not available on this seat: ${a.unsupportedModels.join(', ')}` : ''].filter(Boolean).join(' · '))}">${badge(st, { ...QUOTA_LABELS, warn: a.cooling?.length ? 'Cooling' : QUOTA_LABELS.warn })}</span></div>
      ${a.windows.length ? `<div class="rings">${a.windows.map((w) => ring(w, `${a.provider}-${a.account}-${w.label}`)).join('')}</div>`
        : `<div class="muted small">${esc(a.error ? `Couldn't read quota: ${a.error}` : 'The provider reports no usage windows for this account.')}</div>`}
      <div class="q-foot">${[quotaShort(a) ? `<span class="q-state ${esc(a.status)}" title="${esc(quotaNote(a))}">${esc(quotaShort(a))}</span>` : src, ...foot].filter(Boolean).join(' · ')}</div>
    </div>`;
  }).join(''));
}

// ============================================================ render: machines
function machineCard(m) {
  const s = m.stats, meters = [];
  if (s) {
    if (s.cpu_percent != null) meters.push(meter('CPU', s.cpu_percent, 100, `${s.cpu_percent.toFixed(0)}%${s.load ? ` · load ${s.load[0].toFixed(2)}` : ''}`));
    if (s.mem?.total_bytes) meters.push(meter('Memory', s.mem.used_bytes, s.mem.total_bytes, `${fmtBytes(s.mem.used_bytes)} / ${fmtBytes(s.mem.total_bytes)}`));
    for (const d of (s.disks || []).slice(0, 2)) meters.push(meter(d.mount === '/' ? 'Disk' : `Disk ${d.mount}`, d.used_bytes, d.total_bytes, `${fmtBytes(d.used_bytes)} / ${fmtBytes(d.total_bytes)}`, `disk-${d.mount}`));
    if (s.swap?.total_bytes) meters.push(meter('Swap', s.swap.used_bytes, s.swap.total_bytes, `${fmtBytes(s.swap.used_bytes)} / ${fmtBytes(s.swap.total_bytes)}`));
    for (const [i, g] of (s.gpu || []).entries()) meters.push(meter('GPU', g.util_percent, 100, `${(g.util_percent ?? 0).toFixed(0)}% · ${g.temp_c ?? '–'} °C`, `gpu-${i}`));
  }
  const storageMeters = (m.storage || []).map((st) => meter(st.name, st.used_bytes, st.total_bytes, `${fmtBytes(st.used_bytes)} / ${fmtBytes(st.total_bytes)}`, `st-${st.name}`));
  // Hosts with guests/storage (a Proxmox host) get a full-width card laid out in columns.
  const wide = !!m.wide;
  if (!wide) meters.push(...storageMeters);

  const facts = [];
  if (s?.uptime_s != null) facts.push(`Up <b>${fmtDur(s.uptime_s)}</b>`);
  if (m.ping?.ms != null) facts.push(`Ping <b>${m.ping.ms.toFixed(0)} ms</b>${m.ping.via && m.ping.via !== 'direct' ? ` via ${esc(m.ping.via)}` : ''}`);
  if (s?.battery) facts.push(`Battery <b>${s.battery.percent}%</b> ${s.battery.ac ? 'on AC' : '<b style="color:var(--critical-ink)">ON BATTERY</b>'}`);
  if (s?.iowait_percent != null) facts.push(`I/O wait <b>${s.iowait_percent}%</b>`);
  if (s?.cpu_temp_c != null) facts.push(`CPU <b>${Math.round(s.cpu_temp_c)} °C</b>`);
  if (s?.ollama) facts.push(`Ollama <b>${s.ollama.running ? 'running' : 'stopped'}</b>`);
  if (m.tailscale?.exitNode) facts.push('Exit node');

  const guests = (m.guests || []).map((g) => {
    const st = g.status === 'running' ? 'ok' : (g.onboot === false ? 'off' : 'down');
    return `<span class="guest st-${st}" data-key="g-${g.vmid}" title="${esc(`${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid}${g.pveName && g.pveName !== g.name ? ` (${g.pveName} in Proxmox)` : ''} · ${g.status}${g.maxmem_bytes ? ` · memory ${fmtBytes(g.mem_bytes)} / ${fmtBytes(g.maxmem_bytes)}` : ''}`)}">${STATUS_ICONS[st]}<span>${esc(g.name)}</span><span class="muted">${g.vmid}</span></span>`;
  }).join('');

  const acked = ackedKeys();
  const checksOk = m.checks.filter((c) => c.status === 'ok').length;
  const checksAll = m.checks.filter((c) => c.status !== 'off').length;
  const ackN = m.checks.filter((c) => acked.has(`check:${m.id}:${c.name}`)).length;
  const st = displayStatus(m);
  const hasSpark = m.history.length > 1 && s;
  const sparks = hasSpark ? `<div class="sparks">${sparkline(m.history, 'cpu', 'CPU · last 2 h', `sp-${m.id}-cpu`)}${sparkline(m.history, 'mem', 'Memory · last 2 h', `sp-${m.id}-mem`)}</div>` : '';
  const factsHtml = facts.length ? `<div class="facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>` : '';
  const guestList = (m.guests || []).map((g) => {
    const gst = g.status === 'running' ? 'ok' : (g.onboot === false ? 'off' : 'down');
    const mem = g.status === 'running' && g.maxmem_bytes ? `${fmtBytes(g.mem_bytes)} / ${fmtBytes(g.maxmem_bytes)}` : '';
    return `<div class="g-row" data-key="gl-${g.vmid}" data-status="${gst}"><span class="g-ico st-${gst}">${STATUS_ICONS[gst]}</span>
      <span class="g-name" title="${esc(g.ts ? `${g.name} · Tailscale node ${g.ts.node}${g.ts.online === false ? ' (offline)' : ''}` : g.name)}"><span class="nm">${esc(g.name)}</span>${g.ts?.role === 'exit node' ? '<span class="tag" title="Tailscale exit node">exit</span>' : ''}${g.ts && g.ts.online === false && g.status === 'running' ? '<span class="tag sec">tailnet offline</span>' : ''}</span><span class="g-id">${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid} · ${esc(g.status)}</span>
      <span class="g-mem">${esc(mem)}</span></div>`;
  }).join('');
  const skel = (n) => `<div class="meters">${Array.from({ length: n }, () => '<span class="sk sk-bar" style="height:6px;margin:5px 0"></span>').join('')}</div>`;
  const body = wide && !s
    ? `<div class="wide-body">
        <div class="wcol" data-key="w-res"><div class="col-title">Resources</div>${skel(4)}</div>
        <div class="wcol" data-key="w-sto"><div class="col-title">Storage</div>${skel(3)}</div>
        <div class="wcol" data-key="w-gst"><div class="col-title">Guests <span class="muted">collecting…</span></div>${skel(5)}</div>
      </div>`
    : wide
    ? `<div class="wide-body">
        <div class="wcol" data-key="w-res"><div class="col-title">Resources</div>${meters.length ? `<div class="meters">${meters.join('')}</div>` : ''}${factsHtml}</div>
        <div class="wcol" data-key="w-sto"><div class="col-title">Storage</div>${storageMeters.length ? `<div class="meters">${storageMeters.join('')}</div>` : '<span class="muted small">No storage data</span>'}${sparks}</div>
        <div class="wcol" data-key="w-gst"><div class="col-title">Guests <span class="muted">${(m.guests || []).filter((g) => g.status === 'running').length} of ${(m.guests || []).length} running</span></div><div class="scroll-wrap"><div class="guest-list" data-keep-scroll>${guestList || '<span class="muted small">None</span>'}</div></div></div>
      </div>`
    : `${meters.length ? `<div class="meters">${meters.join('')}</div>` : `<div class="muted small">${esc(m.role)}</div>`}${sparks}${guests ? `<div class="guest-strip">${guests}</div>` : ''}${factsHtml}`;
  return `<div class="card ${wide ? 'wide' : ''} ${m.status === 'off' ? 'off' : ''} ${m.job ? 'updating' : ''}" role="button" tabindex="0" data-machine="${esc(m.id)}" data-key="m-${esc(m.id)}" data-status="${esc(st)}" aria-label="${esc(m.name)}, ${esc(MACHINE_LABELS[st])}. Open details">
    ${m.job ? '<div class="job-stripe" aria-hidden="true"></div>' : ''}
    <div class="card-head">
      <div class="m-ident"><span class="m-icon">${machineIcon(m)}</span>
        <div class="card-title"><span class="name">${esc(m.name)}</span><span class="meta">${esc(m.os)}${s?.os?.version ? ' ' + esc(s.os.version) : ''} · ${esc(m.site)}</span></div></div>
      <div class="card-right">${badge(st, MACHINE_LABELS)}${m.refreshing && m.collectedAt ? '<span class="muted small upd-now"><span class="spinner"></span>Updating…</span>' : m.collectedAt ? `<span class="muted small" data-ago="${m.collectedAt}">${esc(ago(m.collectedAt))}</span>` : ''}</div>
    </div>
    ${m.status !== 'ok' && st !== 'ack' ? `<div class="reason">${esc(m.reason)}</div>` : ''}
    ${body}
    <div class="card-foot">
      <span>${checksAll ? `${checksOk}/${checksAll} checks OK${ackN ? ` · ${ackN} acknowledged` : ''}` : (s ? 'Stats via agent' : '')}</span>
      <span>${m.job ? '<span class="pill busy"><span class="spinner"></span>Updating</span>' : m.updates.total ? `<span class="pill ${m.updates.security ? 'sec' : ''}">${m.updates.total.toLocaleString()} update${m.updates.total === 1 ? '' : 's'}</span>` : (m.updates.checkedAt ? '<span class="muted">Up to date</span>' : '')}</span>
    </div>
  </div>`;
}

function deviceTile(m) {
  const st = displayStatus(m);
  const meta = [m.os, m.site].filter(Boolean).join(' · ');
  const extra = [m.ping?.ms != null ? `${m.ping.ms.toFixed(0)} ms` : (m.tailscale && !m.tailscale.online ? `seen ${ago(m.tailscale.lastSeen)}` : ''), m.tailscale?.exitNode ? 'exit node' : ''].filter(Boolean).join(' · ');
  return `<button class="device" type="button" data-machine="${esc(m.id)}" data-key="d-${esc(m.id)}" data-status="${esc(st)}" aria-label="${esc(`${m.name}, ${MACHINE_LABELS[st]}. Open details`)}">
    <span class="m-icon">${machineIcon(m)}</span>
    <span class="d-body"><span class="d-name"><span class="d-dot ${esc(st)}" aria-hidden="true"></span>${esc(m.name)}</span>
      <span class="d-meta">${esc(meta)}</span><span class="d-meta">${esc(`${MACHINE_LABELS[st]}${extra ? ` · ${extra}` : ''}`)}</span></span>
    ${badge(st, MACHINE_LABELS).replace('<span class="lbl">', '<span class="lbl" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">')}
  </button>`;
}

function renderMachines(s) {
  // stable order (as configured): cards never jump around when a status changes
  const sorted = [...s.machines];
  const isWide = (m) => !!m.wide;
  const full = sorted.filter((m) => m.collector).sort((a, b) => isWide(b) - isWide(a));
  const light = sorted.filter((m) => !m.collector);
  const lightOnline = light.filter((m) => m.status === 'ok').length;
  const panel = light.length ? `<div class="devices-panel glass" data-key="devices-panel">
      <div class="panel-head"><h3>Other devices · reachability only</h3><span class="muted small">${lightOnline} of ${light.length} online</span></div>
      <div class="devices-grid">${light.map(deviceTile).join('')}</div></div>` : '';
  const root = $('#machines');
  // wide host cards first, then the regular cards in their own row (so they split the width evenly), then other devices
  const wideCards = full.filter(isWide), regular = full.filter((m) => !isWide(m));
  morph(root, wideCards.map(machineCard).join('')
    + (regular.length ? `<div class="mrow" data-key="mrow" style="--n:${regular.length}">${regular.map(machineCard).join('')}</div>` : '')
    + panel);
  bindSparks(root);
}

// ============================================================ render: services
function renderServices(s) {
  const acked = ackedKeys();
  const nameOf = (id) => s.machines.find((m) => m.id === id)?.name || id;
  const rows = [
    ...s.services.map((x) => ({ ...x, key: `probe:${x.id}`, where: nameOf(x.machine) })),
    ...s.machines.flatMap((m) => m.checks.filter((c) => c.group !== 'Resources').map((c) => ({ ...c, key: `check:${m.id}:${c.name}`, group: `${m.name} · ${c.group}` }))),
  ].map((r) => ({ ...r, shown: (r.status === 'down' || r.status === 'warn') && acked.has(r.key) ? 'ack' : r.status }))
    .filter((r) => svcFilter === 'all' || r.shown === 'down' || r.shown === 'warn');
  const groups = new Map();
  for (const r of rows) { if (!groups.has(r.group)) groups.set(r.group, []); groups.get(r.group).push(r); }
  if (!rows.length) {
    morph($('#services'), `<div class="group" data-key="svc-empty"><div class="empty">${svcFilter === 'all' ? 'No checks yet.' : 'No open problems. Every check is passing or acknowledged.'}</div></div>`);
    return;
  }
  morph($('#services'), [...groups].map(([g, rs]) => {
    const bad = rs.filter((r) => r.shown === 'down' || r.shown === 'warn').length;
    const downN = rs.filter((r) => r.shown === 'down').length;
    const quiet = rs.filter((r) => r.shown === 'off' || r.shown === 'ack').length;
    const okN = rs.filter((r) => r.shown === 'ok').length;
    const gst = downN ? 'down' : bad ? 'warn' : okN ? 'ok' : 'off';
    const label = downN ? `${downN} of ${rs.length} down` : bad ? `${bad} of ${rs.length} need attention` : okN ? `${okN} OK` : `${rs.length} stopped`;
    const tip = quiet ? ` title="${quiet} more stopped on purpose or hidden (listed inside, in grey)"` : '';
    return `<details class="group-wrap" data-key="g-${esc(g)}" data-status="${gst}" ${bad || svcFilter !== 'all' ? 'open' : ''} ${svcFilter !== 'all' ? 'data-force' : ''}><summary class="group-title"><span>${esc(g)}</span><span class="g-sum"${tip}>${badge(gst, { ok: label, warn: label, down: label, off: label })}</span></summary>
      <div class="group">${rs.map((r) => `<div class="row" data-key="${esc(r.key)}" data-status="${esc(r.shown)}">
        <span>${badge(r.shown)}</span>
        <span class="name">${r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.name)}</a>` : esc(r.name)}</span>
        <span class="detail">${esc(r.detail)}</span>
        <span class="lat">${r.ms != null ? `${r.ms} ms` : ''}</span>
        <span class="r-act">${r.stoppedKey ? unstopBtn(r.stoppedKey, r.name).replace('class="ack-btn"', 'class="ack-btn icon"') : r.shown === 'down' ? stopBtn(r.key, r.name).replace('class="ack-btn"', 'class="ack-btn icon"') : ''}</span></div>`).join('')}</div></details>`;
  }).join(''));
}

// ------------------------------------------------------------ Recent activity (event log)
let activityFilter = 'all';
let activityShown = 10;
const EVENT_ICON = { problem: null, recovered: null, alert: 'info', job: 'download', ack: 'hide', stopped: 'stop', terminal: 'terminal', failover: 'failover', system: 'info' };
const EVENT_GROUP = { problem: 'problems', recovered: 'problems', alert: 'problems', failover: 'problems', job: 'actions', ack: 'actions', stopped: 'actions', terminal: 'actions', system: 'actions' };
function eventIcon(e) {
  if (e.kind === 'problem' || e.kind === 'recovered' || (e.kind === 'job' && e.status !== 'running')) return STATUS_ICONS[e.status === 'down' ? 'down' : e.status === 'warn' ? 'warn' : 'ok'];
  if (e.kind === 'job') return '<span class="spinner" style="width:12px;height:12px;color:var(--accent)"></span>';
  return SYM[EVENT_ICON[e.kind]] || SYM.info;
}
function dayLabel(t) {
  const d = new Date(t), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
function renderJobs(s) {
  const done = new Set((s.events || []).filter((e) => e.kind === 'job' && e.status !== 'running').map((e) => e.job));
  const all = (s.events || [])
    .filter((e) => !(e.kind === 'job' && e.status === 'running' && done.has(e.job)))
    .filter((e) => activityFilter === 'all' || EVENT_GROUP[e.kind] === activityFilter);
  const shown = all.slice(0, activityShown);
  if (!shown.length) { morph($('#jobs'), '<div class="group" data-key="ev-empty"><div class="empty">Nothing here yet.</div></div>'); return; }
  const jobIds = new Set((s.jobs || []).map((j) => j.id));
  const ackedNow = new Set((s.summary.acknowledged || []).map((p) => p.key));
  const stoppedNow = new Set((s.summary.stopped || []).map((p) => p.key));
  const undo = (e) => {
    if (e.kind === 'ack' && e.key && ackedNow.has(e.key) && e.title.startsWith('Hid')) return `<button class="btn" type="button" data-unack="${esc(e.key)}">Show again</button>`;
    if (e.kind === 'stopped' && e.title.endsWith(' marked as stopped on purpose')) {
      const name = e.title.replace(/ marked as stopped on purpose$/, '');
      // older entries have no key: match the item by name
      const key = e.key || (s.summary.stopped || []).find((p) => p.name === name)?.key;
      if (key && stoppedNow.has(key)) return `<button class="btn" type="button" data-unstop="${esc(key)}" data-name="${esc(name)}">Expect running</button>`;
    }
    return '';
  };
  let html = '', day = null;
  for (const e of shown) {
    const dl = dayLabel(e.at);
    if (dl !== day) { if (day) html += '</div>'; html += `<div class="ev-day" data-key="d-${esc(dl)}">${esc(dl)}</div><div class="group ev-group" data-key="dg-${esc(dl)}">`; day = dl; }
    const st = e.status === 'down' ? 'down' : e.status === 'warn' ? 'warn' : e.status === 'ok' ? 'ok' : e.status === 'off' ? 'off' : 'info';
    html += `<div class="ev" data-key="e-${esc(e.id)}" data-status="${st}">
      <span class="ev-time" title="${esc(new Date(e.at).toLocaleString())}">${esc(new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span>
      <span class="ev-ico ${st}">${eventIcon(e)}</span>
      <span class="ev-body"><span class="ev-title">${esc(e.title)}</span>${e.detail ? `<span class="ev-detail">${esc(e.detail)}</span>` : ''}</span>
      <span class="ev-where">${esc([e.machine, e.who && e.kind !== 'job' ? e.who.replace(/@github$/, '') : null].filter(Boolean).join(' · '))}</span>
      <span class="ev-act">${e.job && jobIds.has(e.job) ? `<button class="btn" type="button" data-job="${esc(e.job)}" data-job-machine="${esc(e.machineId)}">Log</button>` : undo(e)}</span>
    </div>`;
  }
  if (day) html += '</div>';
  if (all.length > shown.length) html += `<button class="acked-toggle ev-more" type="button" data-more-activity data-key="ev-more">Show ${Math.min(20, all.length - shown.length)} more · ${all.length - shown.length} older</button>`;
  morph($('#jobs'), html);
}

// ============================================================ drawer (machine detail sheet)
function setHash() {
  const h = drawer.machine ? `#${drawer.machine}/${drawer.tab}` : '';
  if (location.hash !== h) history.replaceState(null, '', h || location.pathname);
}
function openDrawer(machineId, tab = 'overview', job = null) {
  drawer = { machine: machineId, tab, job };
  pkgFilter = '';
  setHash();
  const d = $('#drawer');
  if (!d.classList.contains('open')) drawerOpener = document.activeElement;
  d.inert = false; $('.topbar').inert = true; $('main').inert = true;
  d.classList.add('open'); d.setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('on');
  $('#drawer-body').innerHTML = '';
  renderDrawer();
  if (job) watchJob(job);
  setTimeout(() => $('#drawer-close').focus(), 50);
}
function closeDrawer() {
  drawer = { machine: null, tab: 'overview', job: null };
  setHash();
  const d = $('#drawer');
  d.classList.remove('open'); d.setAttribute('aria-hidden', 'true');
  d.inert = true; $('.topbar').inert = false; $('main').inert = false;
  $('#scrim').classList.remove('on');
  clearInterval(jobPoll); jobPoll = null;
  const back = drawerOpener?.isConnected ? drawerOpener : (drawerOpener?.dataset?.machine && document.querySelector(`[data-machine="${CSS.escape(drawerOpener.dataset.machine)}"]`));
  back?.focus?.(); drawerOpener = null;
}

function renderDrawer() {
  if (!drawer.machine || !STATE) return;
  const m = STATE.machines.find((x) => x.id === drawer.machine);
  if (!m) return;
  const st = displayStatus(m);
  morph($('#drawer-title'), `<span class="m-icon" style="width:34px;height:34px">${machineIcon(m)}</span><span>${esc(m.name)}</span>${badge(st, MACHINE_LABELS)}`);
  const activeChecks = m.checks.filter((c) => c.status !== 'off').length;
  // only show tabs that have something in them
  const tabs = [['overview', 'Overview']];
  if (m.checks.length) tabs.push(['checks', `Checks · ${activeChecks}`]);
  if (m.updates.total || m.updates.checkedAt || m.actions?.length) tabs.push(['updates', `Updates · ${m.updates.total.toLocaleString()}`]);
  if (m.controls?.length || m.terminals?.length) tabs.push(['manage', 'Manage']);
  if (m.stats?.top?.length) tabs.push(['processes', 'Processes']);
  if (!tabs.some(([id]) => id === drawer.tab)) { drawer.tab = 'overview'; setHash(); }
  let body = `<div class="tabs" role="tablist" aria-label="${esc(m.name)} sections">${tabs.map(([id, l]) => `<button class="tab ${drawer.tab === id ? 'active' : ''}" role="tab" id="tab-${id}" aria-controls="tab-panel" aria-selected="${drawer.tab === id}" tabindex="${drawer.tab === id ? 0 : -1}" data-tab="${id}" type="button">${esc(l)}</button>`).join('')}</div>`;
  const content = drawer.tab === 'overview' ? drawerOverview(m) : drawer.tab === 'checks' ? drawerChecks(m) : drawer.tab === 'updates' ? drawerUpdates(m)
    : drawer.tab === 'manage' ? drawerManage(m) : drawerProcesses(m);
  body += `<div class="tab-body" id="tab-panel" role="tabpanel" aria-labelledby="tab-${drawer.tab}" tabindex="0" data-key="tab-${drawer.tab}">${content}</div>`;
  if (drawer.job) {
    const j = jobCache.get(drawer.job);
    const running = !j || j.status === 'running';
    body += `<div class="log-wrap" data-key="log-${esc(drawer.job)}"><div class="log-head"><span class="state">${running ? '<span class="spinner" style="width:12px;height:12px;color:#5ac8fa"></span> Running…' : j.status === 'ok' ? `<span style="color:#30d158">${SYM.check.replace('<svg', '<svg width="14" height="14"')}</span> Finished` : `<span style="color:#ff6961">${SYM.x.replace('<svg', '<svg width="14" height="14"')}</span> Failed (exit ${esc(j.exitCode)})`}</span><span>${esc(j?.label || 'Update log')}</span></div>
      <div class="log-progress ${running ? 'on' : ''}"></div><pre class="log" id="job-log">${esc(j?.log || 'Starting…')}</pre></div>`;
  }
  const bodyEl = $('#drawer-body');
  morph(bodyEl, body);
  bindSparks(bodyEl);
  const log = $('#job-log');
  if (log && !log._init) { log._init = true; log.scrollTop = log.scrollHeight; }
}

function drawerOverview(m) {
  const s = m.stats || {};
  const rows = [
    ['Role', m.role], ['Hostname', m.host], ['Where', m.site], ['OS', [m.os, s.os?.version, s.os?.build ? `(${s.os.build})` : ''].filter(Boolean).join(' ')],
    ['Hardware', [s.model, s.cpu_name, s.cores ? `${s.cores} threads` : ''].filter(Boolean).join(' · ')],
    ['Uptime', s.uptime_s != null ? fmtDur(s.uptime_s) : null],
    ['Load average', s.load ? s.load.map((x) => x.toFixed(2)).join(' / ') : null],
    ['Tailscale', m.tailscale ? `${m.tailscale.online ? 'online' : 'offline'} · ${m.tailscale.ip}${m.tailscale.exitNode ? ' · exit node' : ''}` : null],
    ['Ping', m.ping?.ms != null ? `${m.ping.ms} ms (${m.ping.via || 'direct'})` : m.ping?.error || null],
    ['Signed-in user', s.user],
    ['Last collected', m.collectedAt ? `${ago(m.collectedAt)} (${m.collectMs} ms)` : null],
  ].filter(([, v]) => v);
  let html = `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}${m.link ? `<dt>Admin</dt><dd><a href="${esc(m.link)}" target="_blank" rel="noopener">${esc(m.link)}</a></dd>` : ''}</dl>`;
  if (m.status !== 'ok') html += `<div class="reason">${esc(m.reason)}</div>`;
  if (m.history.length > 1) html += `<div class="sparks">${sparkline(m.history, 'cpu', 'CPU · last 2 h', `spd-${m.id}-cpu`)}${sparkline(m.history, 'mem', 'Memory · last 2 h', `spd-${m.id}-mem`)}</div>`;
  if (m.guests?.length) {
    html += `<div><div class="list-title">Guests</div><div class="table-scroll"><table class="upd-table"><thead><tr><th>ID</th><th>Name</th><th>Status</th><th>CPU</th><th>Memory</th><th>Uptime</th></tr></thead><tbody>
      ${m.guests.map((g) => `<tr><td class="num">${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid}</td><td>${esc(g.name)}</td>
        <td>${badge(g.status === 'running' ? 'ok' : (g.onboot === false ? 'off' : 'down'), { ok: 'running', off: 'stopped', down: g.status })}</td>
        <td class="num">${g.status === 'running' ? `${g.cpu_percent}% of ${g.cpus}` : '–'}</td>
        <td class="num">${g.maxmem_bytes ? `${fmtBytes(g.mem_bytes)} / ${fmtBytes(g.maxmem_bytes)}` : '–'}</td>
        <td class="num">${g.uptime_s ? fmtDur(g.uptime_s) : '–'}</td></tr>`).join('')}</tbody></table></div></div>`;
  }
  if (m.disks?.length) {
    html += `<div><div class="list-title">Physical disks</div><div class="table-scroll"><table class="upd-table"><thead><tr><th>Device</th><th>Model</th><th>Type</th><th>Size</th><th>SMART</th></tr></thead><tbody>
      ${m.disks.map((d) => `<tr><td class="mono">${esc(d.dev)}</td><td>${esc(d.model)}</td><td>${esc(d.type)}</td><td class="num">${fmtBytes(d.size_bytes)}</td><td>${badge(d.health === 'PASSED' || d.health === 'OK' ? 'ok' : d.health === 'UNKNOWN' ? 'off' : 'warn', { ok: d.health, warn: d.health, off: 'n/a' })}</td></tr>`).join('')}</tbody></table></div></div>`;
  }
  if (m.versions) html += `<div><div class="list-title">Versions</div><dl class="kv">${Object.entries(m.versions).map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono">${esc(v ?? '–')}</dd>`).join('')}</dl></div>`;
  return html;
}

function drawerChecks(m) {
  if (!m.checks.length) return '<div class="empty">No checks for this machine.</div>';
  const acked = ackedKeys();
  const groups = new Map();
  for (const c of m.checks) { if (!groups.has(c.group)) groups.set(c.group, []); groups.get(c.group).push(c); }
  return [...groups].map(([g, cs]) => `<div data-key="cg-${esc(g)}"><div class="list-title">${esc(g)}</div><div class="group">${cs.map((c) => {
    const st = (c.status === 'warn' || c.status === 'down') && acked.has(`check:${m.id}:${c.name}`) ? 'ack' : c.status;
    const key = `check:${m.id}:${c.name}`;
    const act = c.stoppedKey ? unstopBtn(c.stoppedKey, c.name) : st === 'down' ? stopBtn(key, c.name) : '';
    return `<div class="row check-row" data-key="c-${esc(c.name)}" data-status="${esc(st)}"><span>${badge(st)}</span><span class="name">${esc(c.name)}</span><span class="detail">${esc(c.detail)}</span><span class="r-act">${act}</span></div>`;
  }).join('')}</div></div>`).join('');
}

const ACTION_COPY = {
  'apt-host': 'Runs apt dist-upgrade on the Proxmox host. Containers and VMs keep running; a new kernel needs a reboot later.',
};

function drawerUpdates(m) {
  const u = m.updates;
  const canAct = STATE.instance.active;
  let html = `<div class="upd-summary"><span class="big">${numSpan(u.total, '', false)}</span>
    <span class="txt"><b>${u.total ? `update${u.total === 1 ? '' : 's'} available${u.security ? ` · ${u.security} security` : ''}` : 'Everything is up to date'}</b>
    <span>${u.checkedAt ? `Checked ${esc(ago(u.checkedAt))}` : 'Not checked yet'}${u.rebootRequired ? ' · reboot required' : ''}</span></span>
    <button class="btn" type="button" data-refresh-updates="${esc(m.id)}"><svg class="ico spin-on-busy" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Check now</button></div>`;
  if (u.errors.length) html += `<div class="errors">${u.errors.map(esc).join('<br>')}</div>`;

  if (m.actions.length) {
    html += `<div><div class="list-title">Actions</div><div class="actions-list">${m.actions.map((a) => {
      const risky = a.tier === 'confirm';
      const ready = a.tier !== 'manual' && a.enabled;
      let ctl;
      if (m.job && ready) ctl = '<span class="a-state"><span class="spinner" style="width:13px;height:13px;color:var(--accent);vertical-align:-2px"></span> Busy</span>';
      else if (a.tier === 'manual') ctl = '<span class="tag">By hand</span>';
      else if (!a.enabled) ctl = '<span class="a-state">Up to date</span>';
      else if (!canAct) ctl = '<span class="tag">Active copy only</span>';
      else ctl = `<button class="btn ${risky ? '' : 'primary'}" type="button" data-action="${esc(a.id)}" data-machine="${esc(m.id)}">${risky ? 'Update…' : 'Update'}</button>`;
      return `<div class="act ${ready ? 'ready' : ''} ${risky ? 'risky' : ''}" data-key="a-${esc(a.id)}">
        <span class="a-icon">${a.tier === 'manual' ? SYM.hand : SYM.download}</span>
        <span class="a-body"><span class="a-title">${esc(a.label)}${risky && ready ? '<span class="tag" style="color:var(--warning-ink)">careful</span>' : ''}</span>${a.note ? `<span class="a-note">${esc(a.note)}</span>` : ''}</span>
        ${ctl}</div>`;
    }).join('')}</div></div>`;
  }

  if (!u.items.length) return html;
  const byKind = new Map();
  for (const it of u.items) { if (!byKind.has(it.kind)) byKind.set(it.kind, []); byKind.get(it.kind).push(it); }
  const q = pkgFilter.toLowerCase();
  html += `<div><div class="list-title">Packages</div>
    <label class="pkg-search" data-keep>${SYM.search}<input type="search" id="pkg-filter" placeholder="Filter ${u.items.length.toLocaleString()} packages" autocomplete="off" spellcheck="false" aria-label="Filter packages"></label></div>`;
  html += [...byKind].map(([k, its]) => {
    const sec = its.filter((i) => i.security).length;
    const visible = its.filter((i) => !q || i.name.toLowerCase().includes(q));
    if (q && !visible.length) return '';
    return `<details class="pkg-group" data-key="pk-${esc(k)}" ${its.length <= 8 || q ? 'open' : ''} ${q ? 'data-force' : ''}><summary><b>${esc(k)}</b><span class="cnt"><span class="tag">${its.length}</span>${sec ? `<span class="tag sec">${sec} security</span>` : ''}</span></summary>
      ${visible.slice(0, 400).map((i) => `<div class="pkg"><span class="p-name">${esc(i.name)}${i.hint ? `<span class="hint">${esc(i.hint)}</span>` : ''}</span>
        <span class="p-ver">${i.current ? `${esc(i.current)}<span class="arrow">→</span>` : ''}<span class="new">${esc(i.available || '')}</span></span>
        <span class="p-tags">${i.security ? '<span class="tag sec">security</span>' : ''}${i.restart ? '<span class="tag">restart</span>' : ''}</span></div>`).join('')}
      ${visible.length > 400 ? `<div class="pkg muted">…and ${visible.length - 400} more</div>` : ''}</details>`;
  }).join('');
  return html;
}

// ------------------------------------------------------------ Manage tab (power, guests, services, terminal)
const verbOf = (label) => (/^Shut down/.test(label) ? 'Shut down' : /^Turn (on|off)/.test(label) ? null : label.split(' ')[0]);
function controlButton(m, c, canAct) {
  if (c.manual) return '<span class="tag">By hand</span>';
  if (!canAct) return '<span class="tag">Active copy only</span>';
  if (m.job) return '<span class="a-state"><span class="spinner" style="width:12px;height:12px;color:var(--accent);vertical-align:-2px"></span> Busy</span>';
  return `<button class="btn ${c.risky ? 'danger' : ''}" type="button" data-control="${esc(c.id)}" data-machine="${esc(m.id)}">${esc(verbOf(c.label) || 'Run')}${c.risky ? '…' : ''}</button>`;
}
function drawerManage(m) {
  const canAct = STATE.instance.active;
  const cs = m.controls || [];
  let html = '';
  if (m.terminals?.length) {
    html += `<div data-key="mg-term"><div class="list-title">Terminal</div><div class="actions-list">${m.terminals.map((t) => `<div class="act ready" data-key="t-${esc(t.id)}">
      <span class="a-icon">${SYM.terminal}</span><span class="a-body"><span class="a-title">${esc(t.label)}</span><span class="a-note">${t.id.startsWith('ct-') ? 'Root shell inside the container (pct enter)' : t.id === 'host' ? 'Root shell on the Proxmox host' : 'Login shell over SSH'}</span></span>
      <button class="btn" type="button" data-term="${esc(t.id)}" data-term-label="${esc(t.label)}" data-machine="${esc(m.id)}" ${canAct ? '' : 'disabled'}>Open</button></div>`).join('')}</div></div>`;
  }
  for (const g of ['Power', 'Services', 'Containers']) {
    const items = cs.filter((c) => c.group === g);
    if (!items.length) continue;
    html += `<div data-key="mg-${g}"><div class="list-title">${g}</div><div class="actions-list">${items.map((c) => `<div class="act ${c.manual ? '' : 'ready'} ${c.risky ? 'risky' : ''}" data-key="c-${esc(c.id)}">
      <span class="a-icon">${g === 'Power' ? SYM.power : SYM.restart}</span>
      <span class="a-body"><span class="a-title">${esc(c.label)}${c.risky && !c.manual ? '<span class="tag warn">careful</span>' : ''}</span>${c.target || c.note ? `<span class="a-note">${esc([c.target, c.note].filter(Boolean).join(' · '))}</span>` : ''}</span>
      ${controlButton(m, c, canAct)}</div>`).join('')}</div></div>`;
  }
  const guestCtl = cs.filter((c) => c.group === 'Guests');
  if (guestCtl.length) {
    const byGuest = new Map();
    for (const c of guestCtl) { if (!byGuest.has(c.target)) byGuest.set(c.target, []); byGuest.get(c.target).push(c); }
    html += `<div data-key="mg-guests"><div class="list-title">Guests</div><div class="actions-list">${[...byGuest].map(([vmid, items]) => {
      const g = (m.guests || []).find((x) => String(x.vmid) === vmid) || {};
      const gst = g.status === 'running' ? 'ok' : g.onboot === false ? 'off' : 'down';
      const toggle = items.find((c) => c.kind === 'toggle');
      const power = items.filter((c) => c.kind !== 'toggle');
      return `<div class="act guest-act" data-key="gm-${esc(vmid)}" data-status="${gst}">
        <span class="a-icon">${STATUS_ICONS[gst]}</span>
        <span class="a-body"><span class="a-title">${esc(items[0].targetName)}</span><span class="a-note">${esc(g.status || '')}${g.status === 'running' && g.uptime_s ? ` · up ${fmtDur(g.uptime_s)}` : ''}</span></span>
        <span class="g-ctl">
          ${toggle ? `<label class="switch" title="${esc(toggle.note || '')}"><input type="checkbox" data-control-toggle="${esc(toggle.id)}" data-machine="${esc(m.id)}" ${toggle.on ? 'checked' : ''} ${canAct && !m.job ? '' : 'disabled'}><span class="sw"></span><span class="sw-lbl">Start at boot</span></label>` : ''}
          ${power.map((c) => controlButton(m, c, canAct)).join('')}
        </span></div>`;
    }).join('')}</div></div>`;
  }
  if (!html) html = '<div class="empty">Nothing to manage on this machine.</div>';
  return html;
}

async function runControl(machineId, controlId, { silentConfirm = false } = {}) {
  const m = STATE.machines.find((x) => x.id === machineId);
  const c = m?.controls?.find((x) => x.id === controlId);
  if (!c) return false;
  if (!silentConfirm) {
    const ok = await confirmDialog({
      title: `${c.label}?`, message: `On ${m.name}.${c.target ? ` ${c.target}.` : ''}`,
      warn: c.note || null, confirmLabel: verbOf(c.label) || 'Run', risky: !!c.risky,
    });
    if (!ok) return false;
  }
  const t = toast(`${c.label}…`, 'busy');
  try {
    const { job } = await post('/api/action', { machine: machineId, action: controlId, confirm: m.name });
    watchedJobs.set(job, 'running');
    t.close();
    await load();
    return true;
  } catch (err) { t.update(err.message, 'bad'); return false; }
}

// ------------------------------------------------------------ web terminal
let xtermReady = null;
function loadXterm() {
  if (xtermReady) return xtermReady;
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/xterm.css'; document.head.appendChild(css);
  const script = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(`couldn't load ${src}`)); document.head.appendChild(s); });
  xtermReady = script('/vendor/xterm.js').then(() => script('/vendor/addon-fit.js'));
  return xtermReady;
}

async function openTerminal(machineId, targetId, label) {
  const m = STATE.machines.find((x) => x.id === machineId);
  const scrim = document.createElement('div');
  scrim.className = 'term-scrim';
  scrim.innerHTML = `<div class="term-win" role="dialog" aria-label="Terminal: ${esc(m.name)} · ${esc(label)}">
    <div class="term-head"><span class="term-dot connecting" aria-hidden="true"></span><b>${esc(m.name)}</b><span class="muted">${esc(label)}</span>
      <span class="term-state muted small">Connecting…</span><button class="btn icon-btn round" type="button" data-term-close aria-label="Close terminal">${SYM.x}</button></div>
    <div class="term-body"></div></div>`;
  document.body.appendChild(scrim);
  const stateEl = scrim.querySelector('.term-state'), dot = scrim.querySelector('.term-dot');
  const setState = (txt, cls) => { stateEl.textContent = txt; dot.className = `term-dot ${cls}`; };
  let cleanup = () => {};
  const close = () => { cleanup(); scrim.classList.add('out'); setTimeout(() => scrim.remove(), 200); };
  scrim.querySelector('[data-term-close]').onclick = close;
  scrim.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !scrim.querySelector('.xterm')) close(); });
  try { await loadXterm(); } catch (e) { setState(e.message, 'bad'); scrim.querySelector('[data-term-close]').focus(); return; }
  const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
  const term = new window.Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000,
    theme: { background: '#0f0f0e', foreground: '#e6e6e1', cursor: '#e6e6e1', selectionBackground: dark ? '#3a3a37' : '#44443f' },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(scrim.querySelector('.term-body'));
  fit.fit();
  term.focus();
  const ws = new WebSocket(`wss://${location.host}/api/term?machine=${encodeURIComponent(machineId)}&target=${encodeURIComponent(targetId)}`);
  ws.binaryType = 'arraybuffer';
  const enc = new TextEncoder();
  const sendSize = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); };
  ws.onopen = () => { setState('Connected', 'ok'); sendSize(); };
  ws.onmessage = (e) => term.write(new Uint8Array(e.data));
  ws.onclose = () => { setState('Disconnected', 'bad'); term.options.cursorBlink = false; };
  ws.onerror = () => setState('Could not connect (owner only, from this page)', 'bad');
  term.onData((d) => { if (ws.readyState === 1) ws.send(enc.encode(d)); });
  const ro = new ResizeObserver(() => { try { fit.fit(); sendSize(); } catch { /* closing */ } });
  ro.observe(scrim.querySelector('.term-body'));
  cleanup = () => { ro.disconnect(); try { ws.close(); } catch { /* ignore */ } term.dispose(); };
}

// ------------------------------------------------------------ Sites page
function renderSites(s) {
  const sites = s.sites || [];
  const checked = sites.filter((x) => x.status !== 'link');
  const up = checked.filter((x) => x.status === 'ok').length;
  const down = checked.filter((x) => x.status === 'down');
  $('#hero-title').textContent = 'Sites';
  morph($('#hero-sub'), `<span class="dot ${down.length ? 'down' : 'ok'}"></span><span>${down.length ? `${plural(down.length, 'site')} not answering` : 'Every checked site is answering'}</span><span class="muted" style="font-size:13px">· ${up} of ${checked.length - checked.filter((x) => x.status === 'off').length} up${checked.some((x) => x.status === 'off') ? ` · ${checked.filter((x) => x.status === 'off').length} stopped` : ''} · ${sites.length - checked.length} links</span>`);
  $('#sites-meta').textContent = `${sites.length} sites`;
  const groups = new Map();
  for (const x of sites) { if (!groups.has(x.group)) groups.set(x.group, []); groups.get(x.group).push(x); }
  const host = (u) => { try { const h = new URL(u); return h.host + (h.pathname.length > 1 ? h.pathname.replace(/\/$/, '') : ''); } catch { return u; } };
  morph($('#sites'), [...groups].map(([g, xs]) => `<div class="group-wrap" data-key="sg-${esc(g)}"><div class="group-title"><span>${esc(g)}</span><span>${xs.length}</span></div>
    <div class="site-grid">${xs.map((x) => `<a class="site" href="${esc(x.url)}" target="_blank" rel="noopener" data-key="s-${esc(x.name)}" data-status="${esc(x.status)}">
      <span class="site-top"><span class="site-name">${esc(x.name)}</span>${x.status === 'link' ? `<span class="status off"><span class="lbl" style="color:var(--text-muted)">Link</span></span>` : badge(x.status, { ok: 'Up', down: 'Down', off: 'Stopped', unknown: 'Checking' })}</span>
      <span class="site-url">${esc(host(x.url))} ${SYM.ext}</span>
      <span class="site-note">${esc(x.note || '')}</span>
      ${x.status !== 'link' ? `<span class="site-meta">${esc([x.detail, x.ms != null ? `${x.ms} ms` : null].filter(Boolean).join(' · '))}</span>` : ''}
    </a>`).join('')}</div></div>`).join(''));
}

function drawerProcesses(m) {
  return `<div class="group">${m.stats.top.map((p) => `<div class="row process-row" data-key="p-${p.pid}"><span class="lat" style="text-align:left">${p.pid}</span><span class="name">${esc(p.name)}</span><span class="lat">${p.cpu}%</span><span class="lat">${fmtBytes(p.rss_bytes)}</span></div>`).join('')}</div>`;
}

// ============================================================ jobs
const jobCache = new Map();
function watchJob(id) {
  clearInterval(jobPoll);
  const tick = async () => {
    const prev = jobCache.get(id) || { log: '', logLength: 0 };
    try {
      const r = await fetch(`/api/jobs/${encodeURIComponent(id)}?since=${prev.logLength}`);
      if (!r.ok) return;
      const j = await r.json();
      const merged = { ...j, log: prev.log + j.log };
      jobCache.set(id, merged);
      const el = $('#job-log');
      if (el && drawer.job === id) {
        const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 30;
        el.textContent = merged.log || 'Starting…';
        if (atBottom) el.scrollTop = el.scrollHeight;
      }
      if (j.status !== 'running') { clearInterval(jobPoll); jobPoll = null; renderDrawer(); load(); }
    } catch { /* retry next tick */ }
  };
  tick();
  jobPoll = setInterval(tick, 1500);
}

// completion toasts for jobs that finish while you're looking elsewhere
function noticeJobs(s) {
  for (const j of s.jobs) {
    const prev = watchedJobs.get(j.id);
    if (prev === 'running' && j.status !== 'running') {
      const t = toast(j.status === 'ok' ? `${j.label} finished on ${j.machineName}` : `${j.label} failed on ${j.machineName}`, j.status === 'ok' ? 'ok' : 'bad',
        { ms: 6000, action: { label: 'View log', run: () => openDrawer(j.machine, 'updates', j.id) } });
      void t;
    }
    watchedJobs.set(j.id, j.status);
  }
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-status-ui': '1' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ============================================================ actions
async function runAction(machineId, actionId) {
  const m = STATE.machines.find((x) => x.id === machineId);
  const a = m?.actions.find((x) => x.id === actionId);
  if (!a) return;
  const risky = a.tier === 'confirm';
  const ok = await confirmDialog({
    title: `${a.label.replace(/\s*\(\d[\d,]*\)$/, '')}?`,
    message: `On ${m.name}. You can follow the live log while it runs.`,
    warn: risky ? (ACTION_COPY[actionId] || a.note || 'This can briefly interrupt services on this machine.') : (a.note || null),
    confirmLabel: 'Update', risky,
  });
  if (!ok) return;
  const t = toast(`Starting on ${m.name}…`, 'busy');
  try {
    const { job } = await post('/api/action', { machine: machineId, action: actionId, confirm: m.name });
    t.update(`Updating ${m.name}. Running in the background.`, 'info');
    watchedJobs.set(job, 'running');
    drawer.job = job; jobCache.delete(job);
    await load();
    if (drawer.machine === machineId) { renderDrawer(); watchJob(job); }
  } catch (err) { t.update(err.message, 'bad'); }
}

async function setStoppedMark(key, name, on) {
  try {
    await post('/api/stopped', { key, on });
    if (on) toast(`"${name}" marked as stopped on purpose. It goes back to normal once it's running again.`, 'ok', { ms: 6000, action: { label: 'Undo', run: () => setStoppedMark(key, name, false) } });
    else toast(`"${name}" is expected to be running again`, 'info');
    await load();
  } catch (err) { toast(err.message, 'bad'); }
}

async function setAck(key, name, on) {
  try {
    await post(on ? '/api/ack' : '/api/unack', { key });
    if (on) toast(key === '*' ? 'Hidden until something changes' : `Hidden "${name}" until it changes`, 'ok', { ms: 5000, action: key === '*' ? undefined : { label: 'Undo', run: () => setAck(key, name, false) } });
    await load();
  } catch (err) { toast(err.message, 'bad'); }
}

// ============================================================ events
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, .card, .device');
  if (!t) return;
  if (t.dataset.ack) {
    const row = t.closest('.problem');
    if (row && !reduceMotion.matches && t.dataset.ack !== '*') row.classList.add('leaving');
    return setAck(t.dataset.ack, t.dataset.name, true);
  }
  if (t.dataset.unack) return setAck(t.dataset.unack, '', false);
  if (t.dataset.stop) { e.stopPropagation(); return setStoppedMark(t.dataset.stop, t.dataset.name, true); }
  if (t.dataset.unstop) { e.stopPropagation(); return setStoppedMark(t.dataset.unstop, t.dataset.name, false); }
  if (t.hasAttribute('data-toggle-acked')) { showAcked = !showAcked; return renderProblems(STATE); }
  if (t.hasAttribute('data-toggle-stopped')) { showStopped = !showStopped; return renderProblems(STATE); }
  if ((t.matches('.card') || t.matches('.device')) && t.dataset.machine) return openDrawer(t.dataset.machine);
  if (t.dataset.tab) { drawer.tab = t.dataset.tab; pkgFilter = ''; setHash(); return renderDrawer(); }
  if (t.dataset.filter) {
    svcFilter = t.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((c) => { c.classList.toggle('active', c === t); c.setAttribute('aria-pressed', String(c === t)); });
    moveThumb(t.closest('.segmented'));
    return STATE && renderServices(STATE);
  }
  if (t.dataset.job) return openDrawer(t.dataset.jobMachine, 'updates', t.dataset.job);
  if (t.dataset.afilter) {
    activityFilter = t.dataset.afilter; activityShown = 10;
    document.querySelectorAll('[data-afilter]').forEach((c) => { c.classList.toggle('active', c === t); c.setAttribute('aria-pressed', String(c === t)); });
    moveThumb($('#activity-filter'));
    return STATE && renderJobs(STATE);
  }
  if (t.hasAttribute('data-more-activity')) { activityShown += 20; return renderJobs(STATE); }
  if (t.dataset.action) return runAction(t.dataset.machine, t.dataset.action);
  if (t.dataset.control) return runControl(t.dataset.machine, t.dataset.control);
  if (t.dataset.term) return openTerminal(t.dataset.machine, t.dataset.term, t.dataset.termLabel);
  if (t.dataset.refreshUpdates) {
    t.classList.add('busy'); t.disabled = true;
    const tt = toast(`Checking ${STATE.machines.find((m) => m.id === t.dataset.refreshUpdates)?.name} for updates…`, 'busy');
    try { await post('/api/refresh', { machine: t.dataset.refreshUpdates, updates: true }); }
    catch (err) { tt.update(err.message, 'bad'); t.classList.remove('busy'); t.disabled = false; return; }
    tt.update('Update check started. The list fills in as the machine reports (up to a few minutes).', 'info');
    setTimeout(load, 9000);
    return;
  }
  if (t.id === 'drawer-close') return closeDrawer();
  if (t.id === 'btn-refresh') {
    t.classList.add('busy'); t.disabled = true; loadbar.start();
    const tt = toast('Refreshing every machine and check…', 'busy');
    try { await post('/api/refresh', {}); tt.update('Refresh started. Values update as machines report.', 'info'); }
    catch (err) { tt.update(err.message, 'bad'); }
    setTimeout(async () => { await load(); t.classList.remove('busy'); t.disabled = false; }, 6500);
    return;
  }
  if (t.id === 'btn-check-updates') {
    t.disabled = true; loadbar.start();
    const tt = toast('Checking every machine for updates. This takes a minute or two.', 'busy');
    try { await post('/api/refresh', { updates: true }); } catch (err) { tt.update(err.message, 'bad'); t.disabled = false; return; }
    tt.update('Update check started on every machine. Lists fill in as machines report (a few minutes).', 'info');
    setTimeout(async () => { await load(); t.disabled = false; }, 9000);
    return;
  }
  if (t.id === 'btn-theme') {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', document.documentElement.dataset.theme); } catch { /* ignore */ }
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'pkg-filter') { pkgFilter = e.target.value; renderDrawer(); }
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (!el.dataset?.controlToggle) return;
  const want = el.checked;
  el.checked = !want; // only flip once the change has actually run
  if (await runControl(el.dataset.machine, el.dataset.controlToggle)) el.checked = want;
});
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.term-scrim')) return; // the terminal owns the keyboard (Esc, Ctrl-C…)
  if (e.target.matches?.('.tab') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    const tabs = [...document.querySelectorAll('#drawer .tab')];
    const i = tabs.indexOf(e.target);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    drawer.tab = tabs[next].dataset.tab; pkgFilter = ''; setHash(); renderDrawer();
    document.getElementById(`tab-${drawer.tab}`)?.focus();
    return;
  }
  if (e.key === 'Escape' && drawer.machine && !document.querySelector('.dialog-scrim')) closeDrawer();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.card')) { e.preventDefault(); openDrawer(e.target.dataset.machine); }
});
$('#scrim').addEventListener('click', closeDrawer);

function moveThumb(seg) {
  if (!seg) { document.querySelectorAll('.segmented').forEach((x) => moveThumb(x)); return; }
  const active = seg.querySelector('.seg.active'); const thumb = seg.querySelector('.seg-thumb');
  if (!active || !thumb || !active.offsetWidth) return;
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.transform = `translateX(${active.offsetLeft - 3}px)`;
}
addEventListener('resize', () => moveThumb());

// "updated 12s ago" stays alive between fetches
setInterval(() => {
  if (!STATE) return;
  $('#updated').textContent = `Live · ${ago(STATE.generatedAt)}`;
  document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = ago(Number(el.dataset.ago)); });
}, 1000);

// ============================================================ load loop
async function load() {
  try {
    const r = await fetch(EMBED ? '/api/state?wall=1' : '/api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    STATE = await r.json();
    renderHeader(STATE);
    if (VIEW === 'sites') renderSites(STATE);
    else if (VIEW === 'maps') { /* maps.js draws the page; this loop keeps the header live */ }
    else {
      renderHero(STATE); renderTiles(STATE); renderProblems(STATE); renderQuota(STATE);
      renderMachines(STATE); renderServices(STATE); renderJobs(STATE);
    }
    noticeJobs(STATE);
    if (drawer.machine) renderDrawer();
    const live = $('#live');
    live.classList.remove('offline', 'beat'); void live.offsetWidth; live.classList.add('beat');
    $('#updated').textContent = `Live · ${ago(STATE.generatedAt)}`;
    if (firstPaint) {
      firstPaint = false; moveThumb();
      const [mid, tab] = location.hash.slice(1).split('/');
      if (VIEW === 'overview' && mid && STATE.machines.some((m) => m.id === mid)) openDrawer(mid, ['overview', 'checks', 'updates', 'manage', 'processes'].includes(tab) ? tab : 'overview');
    }
    loadbar.done();
  } catch (err) {
    $('#live').classList.add('offline');
    $('#updated').textContent = 'Reconnecting…';
    morph($('#banner'), `<div class="banner bad" data-key="offline">${STATUS_ICONS.down}<div><b>Can't reach the dashboard server.</b> ${esc(err.message)}. Retrying…</div></div>`);
    loadbar.done();
  }
}
loadbar.start();
load();
setInterval(() => { if (!document.hidden) load(); }, 10_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
