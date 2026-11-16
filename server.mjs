// Homelab Status server. Zero npm dependencies (Node >= 22).
//
// Agentless: stats come from small Python reporters piped over SSH (or run
// locally), checks run from here. Optionally two copies run: a primary and a
// backup. Both collect everything all the time; only the active copy is
// reachable at https://status.<tailnet>.ts.net through a Tailscale Service
// (svc:status). The backup advertises itself only while the primary is
// unreachable (see roleLoop).
//
//   node server.mjs           your setup: config.mjs + maps.mjs + instance.json
//   node server.mjs --demo    a fictional home lab with live fake data (examples/)

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEMO = process.argv.includes('--demo') || process.env.STATUS_DEMO === '1';
// Your own config.mjs / maps.mjs if present, else the example lab in examples/.
const sourceOf = (name) => (!DEMO && fs.existsSync(path.join(ROOT, `${name}.mjs`)) ? `${name}.mjs` : `examples/${name}.mjs`);
const CONFIG_FILE = sourceOf('config'), MAPS_FILE = sourceOf('maps');
const CFG = await import(pathToFileURL(path.join(ROOT, CONFIG_FILE)).href);
const { MAPS } = await import(pathToFileURL(path.join(ROOT, MAPS_FILE)).href);
const {
  MACHINES, PROBES = [], UPSTREAM = [], EXPECTED_STOPPED = [], OWNER_LOGINS = [], GUEST_TS = {}, QUOTA_ALERTS = false, SITES = [],
  QUIET_WINDOWS = [], actionsFor = () => [], controlsFor = () => [], terminalTargetsFor = () => [],
} = CFG;
const ALERTS = { enabled: false, afterMin: 3, ...CFG.ALERTS };
// CLIProxyAPI accounts at this priority are "preferred" and, when disabled, shown as
// paused by a quota guard (a script of yours that pauses them near their limit). Optional.
const QUOTA_GUARD_PRIORITY = CFG.QUOTA_GUARD_PRIORITY ?? null;
const CADENCE = CFG.CADENCE || { probes: [30, 120, 300, 60], reporters: [60, 300, 600, 120], agent: [30, 300, 600, 120], ping: [60, 300, 600, 120] };
const guestName = CFG.guestName || ((vmid, raw) => String(raw || `Guest ${vmid}`));
// Time zone for times shown in check details (backup schedules). Default: this host's.
const TIMEZONE = CFG.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
// Two-copy setup (optional): which machine runs the backup and how to name both.
// { backupMachine: 'studio', primary: 'Proxmox Host (CT 106)', backup: 'Mac Studio' }
const FAILOVER = CFG.FAILOVER || null;
// The Proxmox host, if any: guests, guest IPs and the {guest} placeholder come from it.
const PVE_ID = MACHINES.find((m) => m.reporter === 'pve')?.id || null;
// The machine whose reporter reads AI subscription quota (reporterConfig.hub_quota), if any.
const QUOTA_ID = MACHINES.find((m) => m.reporterConfig?.hub_quota)?.id || null;

const instanceFile = path.join(ROOT, 'instance.json');
if (!DEMO && !fs.existsSync(instanceFile)) {
  console.error('instance.json is missing. Copy examples/instance.single.json to instance.json and edit it (docs/SETUP.md),\nor try the demo first: node server.mjs --demo');
  process.exit(1);
}
const INSTANCE = DEMO
  ? { role: 'primary', hostLabel: 'demo', port: Number(process.env.PORT) || 3900, dataDir: path.join(os.tmpdir(), `homelab-status-demo-${Number(process.env.PORT) || 3900}`), access: {}, tailscale: false, allowAnonymousActions: true, demo: true }
  : JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
INSTANCE.access ??= {};
const expand = (p) => p?.replace(/^~(?=\/|$)/, os.homedir());
const DATA_DIR = expand(INSTANCE.dataDir || path.join(ROOT, 'data'));
if (DEMO) fs.rmSync(DATA_DIR, { recursive: true, force: true }); // every demo starts fresh
fs.mkdirSync(DATA_DIR, { recursive: true });

const ROLE = INSTANCE.role || 'primary'; // 'primary' | 'standby'
const PORT = Number(process.env.PORT) || INSTANCE.port || 3900;
const SSH_KEY = expand(INSTANCE.sshKey || '~/.ssh/id_ed25519');
// tailscale: false = no Tailscale on this host (no tailnet status, pings or failover)
const TS_ON = INSTANCE.tailscale !== false;
const TS = (TS_ON && INSTANCE.tailscale) || { cli: 'tailscale' };
const MIN = 60_000, HOUR = 60 * MIN;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ================================================================ persistence
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const store = (() => {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { return {}; }
})();
store.updates ??= {};   // machineId -> { checkedAt, ...raw }
store.upstream ??= {};  // id -> { latest, checkedAt, error }
store.history ??= {};   // machineId -> [{t, cpu, mem}]
store.jobs ??= [];      // recent jobs (logs truncated)
store.role ??= { active: ROLE === 'primary', since: Date.now(), events: [] };
store.acks ??= {};      // problemKey -> { status, name, at, who, lastSeen }
store.stopped ??= {};   // problemKey -> { name, at, who }: turned off on purpose; cleared when it's up again
store.events ??= [];    // activity log (newest last), see logEvent()
store.seen ??= {};      // problemKey -> { status, since, name, machine } for problem open/close events

// ---------------------------------------------------------------- activity log
// The backup copy records takeovers/handbacks (the primary is down then), so
// on the primary its history is read from the backup machine's reporter and merged in.
function activityView() {
  let ev = store.events.slice(-200);
  if (ROLE === 'primary' && FAILOVER?.backupMachine) {
    const remote = live.reports[FAILOVER.backupMachine]?.data?.standby_role?.events || [];
    const have = new Set(ev.filter((e) => e.kind === 'failover').map((e) => Math.round(e.at / 1000)));
    ev = ev.concat(remote.filter((e) => !have.has(Math.round(e.at / 1000))).map((e) => ({
      id: `fo-${e.at}`, at: e.at, kind: 'failover', status: e.active ? 'warn' : 'ok',
      title: e.active ? 'Backup took over the dashboard' : 'Primary is serving again', detail: e.message, machine: FAILOVER.backup || FAILOVER.backupMachine,
    })));
  }
  return ev.sort((x, y) => y.at - x.at).slice(0, 200);
}
// kind: problem | recovered | alert | job | ack | stopped | terminal | failover | system
function logEvent(kind, fields) {
  store.events.push({ id: crypto.randomUUID().slice(0, 8), at: Date.now(), kind, ...fields });
  if (store.events.length > 500) store.events = store.events.slice(-500);
  save();
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, STORE_FILE);
  }, 2000);
}

// live (non-persisted) state
const live = {
  reports: {},   // machineId -> { at, ok, data, error, ms }
  probes: {},    // probeId -> { at, ok, code, ms, detail }
  ts: { at: 0, peers: {}, self: null, error: null },
  pings: {},     // ts name -> { ms, at, error }
};

// ================================================================ process helpers
function run(cmd, args, { input, timeout = 60_000, onData, env } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env || process.env });
    const timer = setTimeout(() => { err += `\n[timed out after ${timeout / 1000}s]`; p.kill('SIGKILL'); }, timeout);
    p.stdout.on('data', (d) => { out += d; onData?.(d.toString()); });
    p.stderr.on('data', (d) => { err += d; onData?.(d.toString()); });
    const finish = (code, signal) => {
      if (done) return; done = true; clearTimeout(timer);
      if (code == null && signal && !err.trim()) err = `stopped by ${signal} before reporting`;
      resolve({ code: code ?? -1, out, err });
    };
    p.on('close', finish);
    p.on('error', (e) => { err += e.message; finish(-1); });
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? '');
  });
}

const sshArgs = (target, remote) => [
  '-i', SSH_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  // no ControlMaster/ControlPersist: the backgrounded master inherits our stdout/stderr
  // pipes and keeps them open, which cut collections off ("exit null")
  target, remote,
];

// Run a shell command on a machine: locally, or over SSH.
function runOn(machineId, command, opts = {}) {
  const access = INSTANCE.access[machineId];
  if (!access) return Promise.resolve({ code: -1, out: '', err: `no access configured for ${machineId}` });
  if (access.local) return run('/bin/bash', ['-lc', command], opts);
  return run('ssh', sshArgs(access.ssh, command), opts);
}

// ================================================================ collectors
const REPORTER_SRC = {
  mac: fs.readFileSync(path.join(ROOT, 'reporters/mac.py')),
  pve: fs.readFileSync(path.join(ROOT, 'reporters/pve.py')),
  linux: fs.readFileSync(path.join(ROOT, 'reporters/linux.py')),
};

async function collectReporter(m, mode) {
  const access = INSTANCE.access[m.id];
  if (!access) return;
  const cfg = { ...m.reporterConfig, mode };
  if (m.reporter === 'pve' && (mode === 'full' || Date.now() - (live.reports[m.id]?.disksAt || 0) > 30 * MIN)) cfg.disks = true;
  const b64 = Buffer.from(JSON.stringify(cfg)).toString('base64');
  const py = m.reporter === 'mac' ? '/usr/bin/python3' : 'python3';
  const t0 = Date.now();
  const res = access.local
    ? await run(py, [path.join(ROOT, `reporters/${m.reporter}.py`), b64], { timeout: mode === 'full' ? 15 * MIN : 90_000 })
    : await run('ssh', sshArgs(access.ssh, `${py} - ${b64}`), { input: REPORTER_SRC[m.reporter], timeout: mode === 'full' ? 15 * MIN : 90_000 });
  let data = null;
  try { data = JSON.parse(res.out.trim().split('\n').pop()); } catch { /* handled below */ }
  const prev = live.reports[m.id] || {};
  if (!data) {
    live.reports[m.id] = { ...prev, at: Date.now(), ok: false, fails: (prev.ok === false ? prev.fails || 1 : 0) + 1, error: (res.err || res.out || `exit ${res.code}`).trim().slice(-400), ms: Date.now() - t0 };
    return;
  }
  // Keep the last disk-health result between the 30-minute SMART reads.
  if (!data.disks && prev.data?.disks) data.disks = prev.data.disks;
  live.reports[m.id] = { at: Date.now(), ok: true, data, error: null, ms: Date.now() - t0, disksAt: cfg.disks ? Date.now() : prev.disksAt };
  pushHistory(m.id, data.stats);
  if (data.updates) { store.updates[m.id] = { ...data.updates, checkedAt: Date.now(), osVersion: osVersionOf(data) }; save(); }
}

async function agentGet(m, p, timeout = 5000) {
  const r = await httpRequest(`${m.agent}${p}`, { timeout });
  if (!r.ok) throw new Error(r.detail);
  return JSON.parse(r.body);
}

async function collectWinAgent(m, mode) {
  const t0 = Date.now();
  try {
    const s = await agentGet(m, '/stats');
    const stats = {
      hostname: s.hostname, os: s.os, cpu_name: s.cpu?.name, cores: s.cpu?.threads, cpu_percent: s.cpu?.percent,
      uptime_s: s.uptime_s, mem: s.mem, disks: s.disks, gpu: s.gpu, user: s.user, ollama: s.ollama, top: s.top || null,
    };
    const prev = live.reports[m.id] || {};
    live.reports[m.id] = { ...prev, at: Date.now(), ok: true, data: { stats }, error: null, ms: Date.now() - t0 };
    pushHistory(m.id, stats);
    if (mode === 'full') {
      const u = await agentGet(m, '/updates' + (mode === 'full' && !store.updates[m.id] ? '?refresh=1' : ''));
      if (u.checked_at) {
        store.updates[m.id] = { winget: u.winget || [], windows_update: u.windows_update || [], windows_update_error: u.windows_update_error,
          pending_reboot: u.pending_reboot, checkedAt: Date.parse(u.checked_at) || Date.now(), osVersion: osVersionOf(live.reports[m.id]?.data) };
        save();
      }
    }
  } catch (e) {
    const prev = live.reports[m.id] || {};
    live.reports[m.id] = { ...prev, at: Date.now(), ok: false, fails: (prev.ok === false ? prev.fails || 1 : 0) + 1, error: String(e.message || e), ms: Date.now() - t0 };
  }
}

function pushHistory(id, s) {
  if (!s) return;
  const h = (store.history[id] ??= []);
  const mem = s.mem?.total_bytes ? Math.round(1000 * s.mem.used_bytes / s.mem.total_bytes) / 10 : null;
  h.push({ t: Date.now(), cpu: s.cpu_percent ?? null, mem });
  while (h.length > 180) h.shift();
}

async function collectTailscale() {
  if (!TS_ON || DEMO) return;
  const r = await run(TS.cli, [...(TS.socket ? [`--socket=${expand(TS.socket)}`] : []), 'status', '--json'], { timeout: 15_000 });
  try {
    const d = JSON.parse(r.out);
    const peers = {};
    // Include this host's own node too (e.g. the backup runs on a machine it also monitors).
    for (const p of [...Object.values(d.Peer || {}), ...(d.Self ? [{ ...d.Self, Online: true }] : [])]) {
      const label = (p.DNSName || '').split('.')[0].toLowerCase();
      peers[label] = { host: p.HostName, ip: p.TailscaleIPs?.[0], online: !!p.Online, lastSeen: p.LastSeen, exitNode: !!p.ExitNodeOption, routes: p.PrimaryRoutes || [], os: p.OS, tags: p.Tags || [] };
    }
    const health = (d.Health || []).map(String);
    live.ts = {
      at: Date.now(), peers, self: d.Self ? (d.Self.DNSName || '').split('.')[0] : null, error: null,
      backend: d.BackendState || null,
      // "can't reach the coordination server" = this host's internet is in trouble, not the tailnet peers
      controlLost: health.some((h) => /coordination server|network map/i.test(h)),
      health: health.slice(0, 5),
    };
  } catch {
    live.ts = { ...live.ts, at: Date.now(), error: (r.err || r.out || 'tailscale status failed').trim().slice(0, 300) };
  }
}

async function pingMachines() {
  if (!TS_ON || DEMO) return;
  await Promise.all(MACHINES.filter((m) => m.ts).map(async (m) => {
    const peer = live.ts.peers[m.ts];
    if (!peer?.online || !peer.ip) { live.pings[m.ts] = { at: Date.now(), ms: null, error: 'offline' }; return; }
    const r = await run(TS.cli, [...(TS.socket ? [`--socket=${expand(TS.socket)}`] : []), 'ping', '-c', '1', '--timeout', '3s', peer.ip], { timeout: 8000 });
    const mm = /in ([\d.]+)ms/.exec(r.out);
    const via = /via (DERP\([^)]+\)|[\d.:\[\]a-f]+)/.exec(r.out)?.[1];
    live.pings[m.ts] = { at: Date.now(), ms: mm ? Number(mm[1]) : null, via: via?.startsWith('DERP') ? via : (via ? 'direct' : null), error: mm ? null : (r.out + r.err).trim().split('\n').pop()?.slice(0, 120) };
  }));
}

// ---------------------------------------------------------------- probes
function httpRequest(url, { insecure = false, timeout = 6000, method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, rejectUnauthorized: !insecure, timeout, headers: { 'user-agent': 'status-dashboard/1', ...headers } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (buf.length < 2_000_000) buf += d; });
      res.on('end', () => resolve({ ok: res.statusCode < 400, code: res.statusCode, ms: Date.now() - t0, body: buf, detail: `HTTP ${res.statusCode}` }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout / 1000}s`)));
    req.on('error', (e) => resolve({ ok: false, code: null, ms: Date.now() - t0, detail: e.code === 'ECONNREFUSED' ? 'connection refused' : e.message }));
    req.end(body);
  });
}

function tcpProbe(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port, timeout });
    s.once('connect', () => { s.destroy(); resolve({ ok: true, ms: Date.now() - t0, detail: 'port open' }); });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, ms: Date.now() - t0, detail: 'timeout' }); });
    s.once('error', (e) => resolve({ ok: false, ms: Date.now() - t0, detail: e.code === 'ECONNREFUSED' ? 'connection refused' : e.message }));
  });
}

function dnsProbe(server, name, timeout = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = dgram.createSocket('udp4');
    const id = crypto.randomInt(65535);
    const qname = Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
    const q = Buffer.concat([Buffer.from([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), qname, Buffer.from([0, 1, 0, 1])]);
    const timer = setTimeout(() => { sock.close(); resolve({ ok: false, ms: Date.now() - t0, detail: 'no answer (timeout)' }); }, timeout);
    sock.on('message', (msg) => {
      clearTimeout(timer); sock.close();
      const rcode = msg[3] & 15, answers = msg.readUInt16BE(6);
      resolve({ ok: rcode === 0 && answers > 0, ms: Date.now() - t0, detail: rcode === 0 ? `resolved ${name}` : `DNS error code ${rcode}` });
    });
    sock.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, ms: Date.now() - t0, detail: e.message }); });
    sock.send(q, 53, server);
  });
}

// macOS 15+ "Local Network" privacy blocks LAN connections from unapproved
// binaries (our node) with EHOSTUNREACH; Apple's own curl/nc are exempt. On the
// Mac backup (instance.lanViaSystemTools) LAN targets are probed through them.
const isLan = (host) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);

async function curlProbe(url, insecure) {
  const r = await run('/usr/bin/curl', ['-s', '-o', '/dev/null', '-m', '6', '-w', '%{http_code} %{time_total}', ...(insecure ? ['-k'] : []), url], { timeout: 10_000 });
  const [code, t] = r.out.trim().split(' ');
  const c = Number(code);
  return c ? { ok: c < 400, code: c, ms: Math.round(Number(t) * 1000), detail: `HTTP ${c}` } : { ok: false, code: null, ms: null, detail: `curl exit ${r.code}${r.err ? ': ' + r.err.trim().slice(0, 120) : ''}` };
}
async function ncProbe(host, port) {
  const t0 = Date.now();
  const r = await run('/usr/bin/nc', ['-z', '-G', '4', host, String(port)], { timeout: 8000 });
  return { ok: r.code === 0, ms: Date.now() - t0, detail: r.code === 0 ? 'port open' : 'connection failed' };
}

// Guests without Tailscale (e.g. Pi-hole, TrueNAS) get their LAN IP from DHCP, so it
// can change. Config writes "{guest}" in the URL/host and `guest: <vmid>`; the
// current IP comes from the Proxmox reporter (last known one, then `fallbackIp`).
store.guestIps ??= {};
function guestIp(vmid, fallback) {
  const ip = live.reports[PVE_ID]?.data?.guests?.find((g) => g.vmid === vmid)?.ip;
  if (ip && store.guestIps[vmid] !== ip) { if (store.guestIps[vmid]) log(`guest ${vmid} moved ${store.guestIps[vmid]} -> ${ip}`); store.guestIps[vmid] = ip; save(); }
  return ip || store.guestIps[vmid] || fallback;
}
function atGuest(o) {
  if (!o?.guest) return o;
  const ip = guestIp(o.guest, o.fallbackIp);
  const sub = (v) => (typeof v === 'string' ? v.replaceAll('{guest}', ip) : v);
  return { ...o, url: sub(o.url), host: sub(o.host), server: sub(o.server), link: sub(o.link), check: o.check && typeof o.check === 'object' ? { ...o.check, url: sub(o.check.url) } : o.check };
}

async function runProbes() {
  if (DEMO) return; // demo/demo.mjs fills live.probes
  const viaSys = !!INSTANCE.lanViaSystemTools;
  await Promise.all(PROBES.map(atGuest).map(async (p) => {
    let r;
    if (p.type === 'http') {
      r = viaSys && isLan(new URL(p.url).hostname) && !p.method ? await curlProbe(p.url, p.insecure)
        : await httpRequest(p.url, { insecure: p.insecure, method: p.method || 'GET', ...(p.method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) });
      if (r.code) r.ok = p.expect ? p.expect.includes(r.code) : r.code < 500;
      if (r.ok && r.code === 401) r.detail = 'HTTP 401 (token required, up)';
      if (r.ok && p.describe) { try { const d = p.describe(JSON.parse(r.body)); if (d) r.detail = `${r.detail} · ${d}`; } catch {} }
      delete r.body;
    } else if (p.type === 'tcp') r = viaSys && isLan(p.host) ? await ncProbe(p.host, p.port) : await tcpProbe(p.host, p.port);
    else if (p.type === 'dns') r = await dnsProbe(p.server, p.query);
    else if (p.type === 'tailscale' && !TS_ON) r = { ok: false, detail: 'Tailscale is turned off for this copy (instance.json)' };
    else if (p.type === 'tailscale') {
      const peer = live.ts.peers[p.node];
      r = peer ? { ok: peer.online, detail: peer.online ? `online (${peer.ip})` : `offline, last seen ${peer.lastSeen}` } : { ok: false, detail: 'not in tailnet' };
      if (peer?.online) {
        const missing = (p.routes || []).filter((x) => !peer.routes.includes(x));
        if (p.exitNode && !peer.exitNode) r = { ok: false, detail: `online, but not offering the exit node (${peer.ip})` };
        else if (missing.length) r = { ok: false, detail: `online, but not routing ${missing.join(', ')} (${peer.ip})` };
        else if (p.exitNode || p.routes?.length) r.detail = `online · ${[p.exitNode ? 'exit node' : '', ...(p.routes || []).map((x) => `routes ${x}`)].filter(Boolean).join(' · ')} (${peer.ip})`;
      }
    }
    live.probes[p.id] = { ...r, at: Date.now() };
  }));
}

// ---------------------------------------------------------------- upstream versions
async function checkUpstream() {
  if (DEMO) return;
  for (const u of UPSTREAM) {
    try {
      let latest;
      if (u.source.github) {
        const r = await httpRequest(`https://api.github.com/repos/${u.source.github}/releases/latest`, { timeout: 10_000, headers: { accept: 'application/vnd.github+json' } });
        latest = JSON.parse(r.body).tag_name;
      } else if (u.source.npm) {
        const r = await httpRequest(`https://registry.npmjs.org/${u.source.npm}/latest`, { timeout: 10_000 });
        latest = JSON.parse(r.body).version;
      }
      if (!latest) throw new Error('no version in response');
      store.upstream[u.id] = { latest: String(latest).replace(/^v/, ''), checkedAt: Date.now(), error: null };
    } catch (e) {
      store.upstream[u.id] = { ...store.upstream[u.id], checkedAt: Date.now(), error: String(e.message || e) };
    }
  }
  save();
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function upstreamView() {
  const out = {};
  for (const u of UPSTREAM) {
    const [mid, key] = u.current.split(':');
    const current = live.reports[mid]?.data?.versions?.[key]?.replace(/^v/, '') || null;
    const s = store.upstream[u.id] || {};
    out[u.id] = { id: u.id, name: u.name, machine: u.machine, current, latest: s.latest || null, checkedAt: s.checkedAt || null,
      error: s.error || null, hint: u.hint || null, outdated: !!(current && s.latest && cmpVersion(s.latest, current) > 0) };
  }
  return out;
}

// ================================================================ view model
// Longer than the slowest collection interval (10 min on the standby copy).
const STALE_MS = 12 * MIN;

function machineView(m, upstream) {
  const rep = live.reports[m.id];
  const peer = m.ts ? live.ts.peers[m.ts] : null;
  const ping = m.ts ? live.pings[m.ts] : null;
  const stale = rep?.at && Date.now() - (rep.okAt || rep.at) > STALE_MS;
  const s = rep?.data?.stats || null;

  let status = 'unknown', reason = 'no data yet';
  const blip = rep && !rep.ok && (rep.fails || 1) < 2 && rep.okAt && Date.now() - rep.okAt < STALE_MS;
  if (m.reporter) {
    if (rep?.ok && !stale) { status = 'ok'; reason = 'collecting'; }
    else if (blip) { status = 'ok'; reason = `last collection failed (${String(rep.error || '').slice(0, 80)}); retrying`; }
    else if (peer && !peer.online) { status = m.optional ? 'off' : 'down'; reason = `offline in Tailscale since ${fmtAgo(peer.lastSeen)}`; }
    else if (rep && !rep.ok && peer?.online) { status = 'warn'; reason = `Online, but stats can't be collected: ${rep.error || 'collector failed'}`; }
    else if (rep && !rep.ok) { status = m.optional ? 'off' : 'down'; reason = rep.error || 'collector failed'; }
    else if (stale) { status = 'unknown'; reason = `no data for ${Math.round((Date.now() - rep.at) / MIN)} min`; }
  } else if (peer) {
    status = peer.online ? 'ok' : (m.optional ? 'off' : 'down');
    reason = peer.online ? 'online' : `offline, last seen ${fmtAgo(peer.lastSeen)}`;
  }

  const checks = machineChecks(m, rep?.data, status).map((c) => applyStopped(`check:${m.id}:${c.name}`, c));
  // A check that vanished while this machine reports normally is healthy again
  // (e.g. a VM check exists only while the VM is stopped): clear its mark.
  if (rep?.ok && !stale) {
    const present = new Set(checks.map((c) => `check:${m.id}:${c.name}`));
    for (const k of Object.keys(store.stopped)) {
      if (k.startsWith(`check:${m.id}:`) && !present.has(k)) { delete store.stopped[k]; save(); log(`stopped-mark cleared (gone/healthy): ${k}`); }
    }
  }
  const mMark = store.stopped[`machine:${m.id}`];
  if (mMark && (status === 'ok' || status === 'warn')) { delete store.stopped[`machine:${m.id}`]; save(); }
  else if (mMark && status === 'down') { status = 'off'; reason = `Turned off on purpose (${fmtAgo(mMark.at)})`; }
  if (status === 'ok' && checks.some((c) => c.status === 'down')) { status = 'warn'; reason = 'some services are down'; }
  else if (status === 'ok' && checks.some((c) => c.status === 'warn')) { status = 'warn'; reason = 'needs attention'; }

  const u = store.updates[m.id];
  const updates = updatesList(m, u, upstream);
  const guestNames = Object.fromEntries((rep?.data?.guests || []).map((g) => [String(g.vmid), guestName(g.vmid, g.name)]));
  const actions = actionsFor(m.id, { updates: u, upstream, guestNames, machine: m }).map(({ cmd, agent, ...a }) => a);
  const controls = controlsFor(m.id, { data: rep?.data, machine: m }).map(({ cmd, agentPower, ...c }) => c);
  const terminals = INSTANCE.access[m.id] ? terminalTargetsFor(m.id, { data: rep?.data }).map(({ remote, ...t }) => t) : [];

  return {
    id: m.id, name: m.name, host: m.host || m.ts || null, icon: m.icon, site: m.site, os: m.os, role: m.role, optional: !!m.optional, link: m.link || null,
    collector: !!m.reporter, wide: !!m.wide,
    refreshing: busy.has(`${m.id}:fast`) || busy.has(`${m.id}:full`),
    status, reason, collectedAt: rep?.at || null, collectMs: rep?.ms || null,
    tailscale: peer ? { online: peer.online, ip: peer.ip, lastSeen: peer.lastSeen, exitNode: peer.exitNode } : null,
    ping, stats: s, history: (store.history[m.id] || []).slice(-120),
    guests: (rep?.data?.guests || null)?.map((g) => {
      const t = GUEST_TS[g.vmid];
      const peer = t ? live.ts.peers[t.node] : null;
      g = { ...g, name: guestName(g.vmid, g.name), pveName: g.name };
      return t ? { ...g, ts: { node: t.node, role: t.role, online: peer ? peer.online : null, exitNode: peer?.exitNode || false } } : g;
    }) || null,
    storage: rep?.data?.storage || null, disks: rep?.data?.disks || null,
    checks, versions: rep?.data?.versions || null,
    updates: { checkedAt: u?.checkedAt || null, items: updates, total: updates.length, security: updates.filter((x) => x.security).length,
      errors: updateErrors(u), rebootRequired: !!(u?.pending_reboot || u?.host?.reboot_required) },
    actions, controls, terminals,
    job: Object.values(jobs).find((j) => j.machine === m.id && j.status === 'running')?.id || null,
  };
}

function machineChecks(m, d, mstatus) {
  const out = [];
  const add = (name, ok, detail, sev = 'down', group = 'Service') => out.push({ name, status: ok === null ? 'unknown' : (ok ? 'ok' : sev), detail, group });
  if (!d) return out;
  const s = d.stats || {};
  // resource thresholds
  for (const dk of s.disks || []) {
    const pct = dk.total_bytes ? (100 * dk.used_bytes) / dk.total_bytes : 0;
    if (pct >= 85) add(`Disk ${dk.mount}`, false, `${pct.toFixed(0)}% full`, pct >= 95 ? 'down' : 'warn', 'Resources');
  }
  for (const st of d.storage || []) {
    const pct = st.total_bytes ? (100 * st.used_bytes) / st.total_bytes : 0;
    add(`Storage ${st.name}`, st.active && pct < 85, st.active ? `${pct.toFixed(0)}% full (${fmtBytes(st.used_bytes)} of ${fmtBytes(st.total_bytes)})` : 'inactive', st.active && pct < 95 ? 'warn' : 'down', 'Resources');
  }
  for (const dk of d.disks || []) {
    if (dk.health && dk.health !== 'UNKNOWN') add(`Disk ${dk.dev} (${dk.model})`, dk.health === 'PASSED' || dk.health === 'OK', `SMART ${dk.health}`, 'warn', 'Resources');
  }
  if (s.mem?.pressure_free_percent != null && s.mem.pressure_free_percent < 15) add('Memory pressure', false, `${s.mem.pressure_free_percent}% free`, 'warn', 'Resources');
  if (s.iowait_percent != null && s.iowait_percent >= 25) add('Disk I/O wait', false, `${s.iowait_percent}% of CPU time waiting on disk`, 'warn', 'Resources');
  if (s.battery && !s.battery.ac) add('Power', false, `on battery (${s.battery.percent}%): power cut?`, 'down', 'Resources');
  if (s.cpu_temp_c != null && s.cpu_temp_c >= 80) add('CPU temperature', false, `${s.cpu_temp_c} °C: it will slow itself down soon`, 'warn', 'Resources');
  if (s.cpu_speed_limit != null && s.cpu_speed_limit < 100) add('Thermal throttling', false, `CPU limited to ${s.cpu_speed_limit}%`, 'warn', 'Resources');
  for (const g of d.gpu || s.gpu || []) if (g.temp_c >= 85) add(`GPU ${g.name}`, false, `${g.temp_c} °C`, 'warn', 'Resources');

  // services
  const names = Object.fromEntries((m.reporterConfig?.launchd || []).map((j) => [j.label, j.name]));
  for (const j of d.launchd || []) add(names[j.label] || j.label, j.ok, `${j.label}: ${j.detail}`, 'down', 'launchd');
  for (const p of d.ports || []) add(p.name, p.ok && !p.warn, p.detail + (p.ms != null ? ` · ${p.ms} ms` : ''), p.ok && p.warn ? 'warn' : 'down', 'Local ports');
  for (const f of d.files || []) add(f.name, f.ok, f.detail, 'warn', 'Jobs');
  for (const p of d.procs || []) add(p.name, p.ok, p.detail, 'down', 'Processes');
  if (d.docker?.error) add('Docker', false, d.docker.error, 'down', 'Docker');
  for (const c of d.docker?.containers || []) {
    const expectedStop = EXPECTED_STOPPED.includes(c.name);
    const running = c.state === 'running';
    out.push({ name: c.name, group: 'Docker', detail: c.status + (expectedStop ? ' · stopped on purpose' : ''),
      status: expectedStop && !running ? 'off' : (!running ? 'down' : (c.health === 'unhealthy' ? 'down' : 'ok')) });
  }
  for (const g of d.guest_services || []) add(g.name, g.ok, `${g.vmid ? `CT ${g.vmid}` : 'host'} · ${g.detail}`, g.failAs || 'down', g.vmid ? 'Guests' : 'Service');
  // scheduled vzdump jobs: warn if the newest backup of any guest is older than ~a week + a day, or the last run failed
  for (const j of d.backups?.jobs || []) {
    const name = `Backup job ${j.id}`;
    const where = `${j.schedule} → ${j.storage}${j.keep?.['keep-last'] ? `, keep ${j.keep['keep-last']}` : ''} · CT ${j.vmids.join(', ')}`;
    if (!j.enabled) { out.push({ name, group: 'Backups', status: 'off', expected: true, detail: `disabled · ${where}` }); continue; }
    const times = j.vmids.map((v) => j.latest?.[v]?.ctime || 0);
    const oldest = times.length ? Math.min(...times) * 1000 : 0;
    const lastTask = d.backups.tasks?.[0];
    const next = j.next_run ? `next ${new Date(j.next_run * 1000).toLocaleString('en-US', { timeZone: TIMEZONE, weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
    const missing = j.vmids.filter((v) => !j.latest?.[v]);
    let ok = true, detail;
    if (missing.length) { detail = `no backup yet of CT ${missing.join(', ')} · ${next}`; ok = !j.next_run || Date.now() < (j.next_run * 1000) + 6 * HOUR; }
    else { detail = `newest of each ${fmtAgo(new Date(oldest).toISOString())} · ${next}`; ok = Date.now() - oldest < 8 * 24 * HOUR + 6 * HOUR; }
    if (lastTask && lastTask.status && lastTask.status !== 'OK') { ok = false; detail = `last run: ${lastTask.status} · ${detail}`; }
    add(name, ok, `${detail} · ${where}`, 'warn', 'Backups');
  }
  for (const c of d.guest_docker || []) add(`${c.name}`, c.state === 'running' && c.health !== 'unhealthy', `CT ${c.vmid} · ${c.status}`, 'down', 'Docker');
  for (const g of d.guests || []) {
    if (g.status === 'running') continue;
    const name = `${g.name} (${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid})`;
    // stopped and not set to start at boot = turned off on purpose
    if (g.onboot === false) out.push({ name, group: 'Guests', status: 'off', expected: true, detail: `${g.status} · set not to start at boot, so this is expected` });
    else add(name, false, g.status, 'down', 'Guests');
  }
  if (d.errors) for (const [k, v] of Object.entries(d.errors)) add(`Collector: ${k}`, false, v, 'warn', 'Collector');
  return out;
}

function updatesList(m, u, upstream) {
  const items = [];
  if (u?.macos?.items) for (const x of u.macos.items) items.push({ kind: 'macOS', name: x.name, available: x.available, restart: x.restart });
  if (u?.brew?.items) for (const x of u.brew.items) items.push({ kind: 'Homebrew', name: x.name, current: x.current, available: x.available });
  if (u?.host?.items) for (const x of u.host.items) items.push({ kind: m.reporter === 'pve' ? 'Proxmox host' : 'apt', name: x.name, current: x.current, available: x.available, security: x.security });
  for (const [vmid, g] of Object.entries(u?.guests || {})) {
    const raw = live.reports[m.id]?.data?.guests?.find((x) => String(x.vmid) === vmid);
    if (live.reports[m.id]?.data?.guests && !raw) continue; // guest no longer exists
    const gname = guestName(Number(vmid), raw?.name);
    for (const x of g.items || []) items.push({ kind: `${gname} (CT ${vmid})`, name: x.name, current: x.current, available: x.available, security: x.security });
  }
  for (const x of u?.winget || []) items.push({ kind: 'winget', name: x.name, current: x.current, available: x.available });
  for (const x of u?.windows_update || []) items.push({ kind: 'Windows Update', name: x.title, available: x.kb, security: /critical|important/i.test(x.severity || ''), restart: x.reboot_required });
  for (const up of Object.values(upstream)) if (up.machine === m.id && up.outdated) items.push({ kind: 'App', name: up.name, current: up.current, available: up.latest, hint: up.hint });
  return items;
}

function updateErrors(u) {
  if (!u) return [];
  const e = [];
  if (u.macos?.error) e.push(`softwareupdate: ${u.macos.error}`);
  if (u.brew?.error) e.push(`brew: ${u.brew.error}`);
  if (u.host?.error) e.push(`apt: ${u.host.error}`);
  if (u.host?.warning) e.push(`apt update: ${u.host.warning}`);
  for (const [id, g] of Object.entries(u.guests || {})) if (g.error) e.push(`apt (CT ${id}): ${g.error}`);
  if (u.windows_update_error) e.push(`Windows Update: ${u.windows_update_error}`);
  return e;
}

function fmtAgo(iso) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!t || t < 0) return 'unknown';
  const s = (Date.now() - t) / 1000;
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function fmtIn(t) {
  const s = Math.max(0, (t - Date.now()) / 1000);
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `${Math.round(s / 86400)} days`;
}
function fmtBytes(b) {
  if (b == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// ---------------------------------------------------------------- AI subscription quota
// Collected by the reporter of the machine with reporterConfig.hub_quota (where the
// CLIProxyAPI management key lives); the key never leaves that machine.
const PROVIDER_NAMES = { claude: 'Claude', codex: 'ChatGPT · Codex', 'kimi-ai': 'Kimi' };
const QUOTA_STALE_MS = 20 * MIN;

function quotaView() {
  const rep = live.reports[QUOTA_ID];
  const q = rep?.data?.hub_quota;
  const where = MACHINES.find((m) => m.id === QUOTA_ID)?.name || 'quota machine';
  if (!q) return { accounts: [], fetchedAt: null, stale: true, enabled: !!QUOTA_ID, error: rep?.ok === false ? `${where} unreachable: ${rep.error}` : 'not collected yet' };
  const fetchedAt = q.fetched_at ? q.fetched_at * 1000 : null;
  const stale = !fetchedAt || Date.now() - fetchedAt > QUOTA_STALE_MS;
  const accounts = (q.accounts || []).map((a, i) => {
    const windows = (a.windows || []).map((w) => ({
      label: w.label, used: Math.max(0, Math.min(100, w.used)), left: Math.max(0, Math.round((100 - w.used) * 10) / 10),
      resetsAt: w.resets_at ? w.resets_at * 1000 : null, locked: w.locked || null,
    }));
    const lowest = windows.reduce((m, w) => (m == null || w.left < m.left ? w : m), null);
    // cooldowns: the hub pauses a model on an account after errors. 404 "not_found" just means this
    // seat can't use that model: not a quota problem.
    const cds = Array.isArray(a.cooldowns) ? a.cooldowns : [];
    const coolingNow = cds.filter((c) => c.reason !== 'not_found' && c.status !== 404 && (!c.until || c.until * 1000 > Date.now()));
    const unsupported = [...new Set(cds.filter((c) => c.reason === 'not_found' || c.status === 404).map((c) => c.model).filter(Boolean))];
    let status = 'ok', statusLabel = 'Available';
    const guarded = QUOTA_GUARD_PRIORITY != null && a.priority === QUOTA_GUARD_PRIORITY;
    if (a.disabled) { status = 'off'; statusLabel = guarded ? 'Paused by quota guard' : 'Disabled in hub'; }
    else if (a.limit_reached || windows.some((w) => w.left <= 0 || w.locked)) { status = 'down'; statusLabel = 'Limit reached'; }
    else if (lowest && lowest.left <= 10) { status = 'warn'; statusLabel = 'Almost used up'; }
    else if (a.unavailable || coolingNow.length) { status = 'warn'; statusLabel = 'Cooling down'; }
    else if (!windows.length) { status = 'unknown'; statusLabel = 'No quota data'; }
    return {
      id: `${a.provider}-${i}`, provider: a.provider, providerName: PROVIDER_NAMES[a.provider] || a.provider, account: a.account,
      plan: a.plan || null, preferred: guarded, resetCredits: a.reset_credits ?? null,
      cooling: coolingNow.map((c) => ({ model: c.model, reason: c.reason, until: c.until ? c.until * 1000 : null })), unsupportedModels: unsupported,
      status, statusLabel, windows, lowest, source: a.source, error: a.error, observedAt: a.observed_at ? a.observed_at * 1000 : null,
      requests: { ok: a.success ?? null, failed: a.failed ?? null },
    };
  });
  return { accounts, fetchedAt, stale, enabled: true, error: q.error || (rep?.ok === false ? `${where} unreachable, showing last values: ${rep.error}` : null) };
}

function stateView() {
  const upstream = upstreamView();
  const quota = quotaView();
  const machines = MACHINES.map((m) => machineView(m, upstream));
  const services = PROBES.map(atGuest).map((p) => {
    const r = live.probes[p.id];
    const mach = machines.find((x) => x.id === p.machine);
    // failAs: 'warn' = has a fallback (e.g. a DNS server with a secondary): shown amber, never alerted
    let status = r ? (r.ok ? 'ok' : (p.failAs || 'down')) : 'unknown';
    if (status === 'down' && MACHINES.find((x) => x.id === p.machine)?.optional && mach?.status === 'off') status = 'off';
    if (r && Date.now() - r.at > STALE_MS) status = 'unknown';
    return applyStopped(`probe:${p.id}`, { id: p.id, name: p.name, group: p.group, machine: p.machine, status, detail: r?.detail || 'not checked yet', ms: r?.ms ?? null, at: r?.at || null, link: p.link || null });
  });
  const stopped = [
    ...services.filter((s) => s.expected && s.stoppedKey).map((s) => ({ key: s.stoppedKey, name: s.name, machine: s.machine, detail: s.detail, at: s.stoppedAt })),
    ...machines.flatMap((m) => m.checks.filter((c) => c.stoppedKey).map((c) => ({ key: c.stoppedKey, name: c.name, machine: m.id, detail: c.detail, at: c.stoppedAt }))),
    ...machines.filter((m) => store.stopped[`machine:${m.id}`] && m.status === 'off').map((m) => ({ key: `machine:${m.id}`, name: m.name, machine: m.id, detail: m.reason, at: store.stopped[`machine:${m.id}`].at })),
  ];
  const allChecks = [
    ...services.map((s) => ({ ...s, where: 'probe' })),
    ...machines.flatMap((m) => m.checks.map((c) => ({ ...c, machine: m.id, where: m.name }))),
  ];
  const allProblems = [
    ...(live.ts.error ? [{ key: 'self:tailscale', kind: 'self', name: `Tailscale on ${INSTANCE.hostLabel}`, detail: `This dashboard can't read Tailscale (${live.ts.error}), so every tailnet check below will fail.`, status: 'down' }] : []),
    // "warn" = online but stats can't be collected (e.g. its LAN address changed); shown, not alerted
    ...machines.filter((m) => m.status === 'down' || m.status === 'warn').map((m) => ({ key: `machine:${m.id}`, kind: 'machine', machine: m.id, name: m.name, detail: m.reason, status: m.status })),
    ...allChecks.filter((c) => c.status === 'down' || c.status === 'warn').map((c) => ({
      key: c.where === 'probe' ? `probe:${c.id}` : `check:${c.machine}:${c.name}`, kind: 'check', machine: c.machine, name: c.name, detail: c.detail, status: c.status })),
    ...quota.accounts.filter((a) => QUOTA_ALERTS && (a.status === 'down' || a.status === 'warn')).map((a) => ({
      key: `quota:${a.provider}:${a.account}`, kind: 'quota', name: `${a.providerName} quota`, status: 'warn', machine: QUOTA_ID,
      detail: `${a.account}: ${a.statusLabel}${a.lowest ? ` (${a.lowest.label} ${a.lowest.left}% left${a.lowest.resetsAt ? `, resets in ${fmtIn(a.lowest.resetsAt)}` : ''})` : ''}`,
    })),
  ];
  const { problems, acknowledged } = applyAcks(allProblems);
  return {
    generatedAt: Date.now(),
    instance: { role: ROLE, host: INSTANCE.hostLabel, active: store.role.active, since: store.role.since, events: store.role.events.slice(-10), peer: rolePeerView(),
      demo: DEMO, failover: FAILOVER ? { primary: FAILOVER.primary || 'the primary', backup: FAILOVER.backup || 'the backup' } : null },
    summary: {
      machinesUp: machines.filter((m) => m.status === 'ok' || m.status === 'warn').length,
      machinesTotal: machines.filter((m) => m.status !== 'off').length,
      checksOk: allChecks.filter((c) => c.status === 'ok').length,
      checksTotal: allChecks.filter((c) => c.status !== 'off').length,
      updates: machines.reduce((n, m) => n + m.updates.total, 0),
      security: machines.reduce((n, m) => n + m.updates.security, 0),
      problems,
      acknowledged,
      stopped,
    },
    tailscale: { at: live.ts.at, error: live.ts.error },
    quota,
    machines, services,
    jobs: Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt).slice(0, 15).map(jobSummary),
    events: activityView(),
  };
}

// ================================================================ acknowledgements
// An acknowledged problem is hidden from "Needs attention" until it changes
// (its status differs from when it was acknowledged), it is un-acknowledged by
// hand, or it has been gone for ACK_FORGET_MS (it resolved; a recurrence is new).
const ACK_FORGET_MS = 10 * MIN;

function applyAcks(all) {
  const now = Date.now();
  const problems = [], acknowledged = [];
  let dirty = false;
  const present = new Set();
  for (const p of all) {
    present.add(p.key);
    const a = store.acks[p.key];
    if (a && a.status === p.status) {
      if (now - (a.lastSeen || 0) > 60_000) { a.lastSeen = now; dirty = true; }
      acknowledged.push({ ...p, ackedAt: a.at, ackedBy: a.who });
    } else {
      if (a) { delete store.acks[p.key]; dirty = true; log(`ack dropped (changed ${a.status} -> ${p.status}): ${p.key}`); }
      problems.push(p);
    }
  }
  for (const [k, a] of Object.entries(store.acks)) {
    if (!present.has(k) && now - (a.lastSeen || a.at) > ACK_FORGET_MS) { delete store.acks[k]; dirty = true; log(`ack forgotten (resolved): ${k}`); }
  }
  if (dirty) save();
  return { problems, acknowledged };
}

function setAck(key, on, who) {
  if (!on) { const a = store.acks[key]; delete store.acks[key]; save(); logEvent('ack', { status: 'info', title: `Showing ${a?.name || 'an item'} again`, who }); return { ok: true }; }
  const state = stateView();
  const keys = key === '*' ? state.summary.problems.map((p) => p.key) : [key];
  let n = 0;
  for (const k of keys) {
    const p = state.summary.problems.find((x) => x.key === k);
    if (!p) continue;
    store.acks[k] = { status: p.status, name: p.name, at: Date.now(), lastSeen: Date.now(), who };
    n++;
  }
  if (!n) throw httpError(404, 'nothing to acknowledge (it may have changed or resolved)');
  save();
  logEvent('ack', { status: 'info', title: key === '*' ? `Hid ${n} item${n === 1 ? '' : 's'} until something changes` : `Hid ${store.acks[key]?.name || key} until it changes`, who, key: key === '*' ? null : key });
  log(`ack by ${who}: ${keys.join(', ')}`);
  return { ok: true, acknowledged: n };
}

// ================================================================ stopped on purpose
// A check marked "stopped on purpose" shows grey (off) instead of red while
// it's down. The mark clears itself as soon as the check is OK again, so the
// next unplanned outage is red.
function applyStopped(key, c) {
  const mark = store.stopped[key];
  if (!mark) return c;
  if (c.status === 'ok') { const s = store.stopped[key]; delete store.stopped[key]; save(); log(`stopped-mark cleared (running again): ${key}`); logEvent('recovered', { status: 'ok', title: `${s?.name || c.name} is running again`, detail: 'Its "stopped on purpose" mark cleared itself' }); return c; }
  if (c.status === 'down' || c.status === 'warn') {
    return { ...c, status: 'off', expected: true, stoppedKey: key, stoppedAt: mark.at, detail: `Stopped on purpose · ${c.detail}` };
  }
  return c;
}

function setStopped(key, on, who) {
  if (!on) { const s = store.stopped[key]; delete store.stopped[key]; save(); log(`stopped-mark removed by ${who}: ${key}`); logEvent('stopped', { status: 'info', title: `${s?.name || key} is expected to run again`, who }); return { ok: true }; }
  const p = stateView().summary.problems.find((x) => x.key === key);
  if (!p) throw httpError(404, 'that item is not down right now');
  store.stopped[key] = { name: p.name, at: Date.now(), who };
  delete store.acks[key];
  save();
  log(`stopped-mark by ${who}: ${key}`);
  logEvent('stopped', { status: 'off', title: `${p.name} marked as stopped on purpose`, detail: 'Shown grey until it is running again', who, key, machine: MACHINES.find((x) => x.id === p.machine)?.name || null });
  return { ok: true };
}

// ================================================================ jobs (update actions)
const jobs = Object.fromEntries((store.jobs || []).map((j) => [j.id, j.status === 'running' && !j.remote && !j.agentJob
  ? { ...j, status: 'failed', finishedAt: Date.now(), log: j.log + '\n[interrupted: the dashboard restarted while this was running; check the machine]\n' }
  : j]));
if (ROLE === 'primary') store.role.active = true;
const jobSummary = ({ log: l, ...j }) => j;

function persistJobs() {
  store.jobs = Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt).slice(0, 30).map((j) => ({ ...j, log: j.log.slice(-20_000) }));
  save();
}

async function startAction(machineId, actionId, confirm, who) {
  const m = MACHINES.find((x) => x.id === machineId);
  if (!m) throw httpError(404, 'unknown machine');
  if (!store.role.active) throw httpError(409, 'this copy is the standby and is not active; updates run only on the active copy');
  if (Object.values(jobs).some((j) => j.machine === machineId && j.status === 'running')) throw httpError(409, 'an update is already running on this machine');
  const upstream = upstreamView();
  const rep = live.reports[machineId];
  const guestNames = Object.fromEntries((rep?.data?.guests || []).map((g) => [String(g.vmid), guestName(g.vmid, g.name)]));
  let action = actionsFor(machineId, { updates: store.updates[machineId], upstream, guestNames, machine: m }).find((a) => a.id === actionId);
  if (!action) {
    const c = controlsFor(machineId, { data: rep?.data, machine: m }).find((x) => x.id === actionId);
    if (c) action = { ...c, tier: c.manual ? 'manual' : c.risky ? 'confirm' : 'safe', enabled: !c.manual, kind: 'control' };
  }
  if (!action) throw httpError(404, 'unknown action');
  if (action.tier === 'manual' || !action.enabled) throw httpError(400, 'this action is not available');
  if (action.tier === 'confirm' && confirm !== m.name) throw httpError(400, 'this needs confirmation in the dashboard first');

  const id = crypto.randomUUID().slice(0, 8);
  const job = { id, machine: machineId, machineName: m.name, action: actionId, label: action.label, who, kind: action.kind || 'update', status: 'running', startedAt: Date.now(), finishedAt: null, exitCode: null, log: '' };
  jobs[id] = job;
  const append = (t) => { job.log += t; if (job.log.length > 400_000) job.log = job.log.slice(-300_000); };
  log(`job ${id}: ${who} started ${machineId}/${actionId}`);
  logEvent('job', { status: 'running', title: `Started: ${action.label}`, machine: m.name, who, job: id, machineId });
  append(`$ ${action.label}\n`);

  (async () => {
    let code;
    try {
    if (DEMO) {
      code = await demo.runJob(job, action, append);
    } else if (action.agentPower) {
      const r = await httpRequest(`${m.agent}/power`, { method: 'POST', timeout: 15_000, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: action.agentPower, ...(action.agentPower === 'cancel' ? {} : { delay_s: 60 }) }) });
      // Windows reports "no shutdown was in progress" (1116) as an error; for cancel that just means nothing to do
      if (action.agentPower === 'cancel' && /\(1116\)/.test(r.body || '')) { append('Nothing was scheduled, so there was nothing to cancel.\n'); code = 0; }
      else { append(`${r.body || r.detail}\n`); code = r.ok ? 0 : 1; }
    } else if (action.agent) {
      code = await runAgentJob(m, action.agent, append, job);
    } else {
      code = await runDetached(machineId, job, action.cmd, append);
    }
    } catch (e) { append(`\n${e.message || e}\n`); code = -1; }
    finishJob(job, code);
  })();
  persistJobs();
  return job;
}

// Commands run detached on the target (nohup, own log file), so a dashboard
// restart, redeploy or failover doesn't kill them; we just follow the log and
// pick it up again after a restart.
const appendTo = (job) => (t) => { job.log += t; if (job.log.length > 400_000) job.log = job.log.slice(-300_000); };

function finishJob(job, code) {
  const m = MACHINES.find((x) => x.id === job.machine);
  job.exitCode = code;
  job.status = code === 0 ? 'ok' : 'failed';
  job.finishedAt = Date.now();
  appendTo(job)(`\n[${job.status} · exit ${code} · ${Math.round((job.finishedAt - job.startedAt) / 1000)} s]\n`);
  log(`job ${job.id}: ${job.status} (${code})`);
  logEvent('job', { status: job.status === 'ok' ? 'ok' : 'down', title: `${job.status === 'ok' ? 'Finished' : 'Failed'}: ${job.label}`, detail: `exit ${code} · ${fmtDuration(job.finishedAt - job.startedAt)}`, machine: job.machineName, who: job.who, job: job.id, machineId: job.machine });
  persistJobs();
  if (!m) return;
  // controls: re-collect status right away; updates: re-check what's left
  refreshMachine(m, job.kind === 'control' ? 'fast' : 'full').catch(() => {});
  if (job.kind === 'control') setTimeout(() => { refreshMachine(m, 'fast').catch(() => {}); runProbes().catch(() => {}); }, 20_000);
}

async function runDetached(machineId, job, cmd, append) {
  const b64 = Buffer.from(`#!/bin/bash\n${cmd}\n`).toString('base64');
  const id = job.id;
  const start = `mkdir -p "$HOME/.status-jobs" && cd "$HOME/.status-jobs" && echo ${b64} | base64 --decode > ${id}.sh && rm -f ${id}.exit `
    + `&& nohup sh -c 'bash ./${id}.sh > ./${id}.log 2>&1; echo $? > ./${id}.exit' >/dev/null 2>&1 </dev/null & echo started`;
  const r = await runOn(machineId, start, { timeout: 30_000 });
  if (!/started/.test(r.out)) { append(`could not start the job: ${(r.err || r.out).trim().slice(0, 300)}\n`); return -1; }
  job.remote = { offset: 0 };
  persistJobs();
  return followDetached(machineId, job, append);
}

async function followDetached(machineId, job, append) {
  const id = job.id, deadline = job.startedAt + 3 * HOUR;
  for (;;) {
    await sleep(2000);
    const r = await runOn(machineId, `cd "$HOME/.status-jobs" 2>/dev/null || exit 3; cat ${id}.exit 2>/dev/null; echo "@@SPLIT@@"; tail -c +${job.remote.offset + 1} ${id}.log 2>/dev/null | base64`, { timeout: 30_000 });
    if (!r.out.includes('@@SPLIT@@')) {
      if (r.code === 3) { append('\nThe job folder is gone on the machine.\n'); return -1; }
      if (Date.now() > deadline) { append('\n[stopped following after 3 h; the job may still be running]\n'); return -1; }
      continue; // transient SSH problem: keep following
    }
    const [exitPart, data] = r.out.split('@@SPLIT@@');
    const chunk = Buffer.from((data || '').replace(/\s+/g, ''), 'base64');
    if (chunk.length) { append(chunk.toString('utf8')); job.remote.offset += chunk.length; persistJobsSoon(); }
    const ex = exitPart.trim();
    if (ex !== '') {
      runOn(machineId, `cd "$HOME/.status-jobs" && rm -f ${id}.sh ${id}.exit ${id}.log`, { timeout: 20_000 }).catch(() => {});
      return Number(ex);
    }
    if (Date.now() > deadline) { append('\n[stopped following after 3 h; the job may still be running]\n'); return -1; }
  }
}

let persistTimer = null;
function persistJobsSoon() { clearTimeout(persistTimer); persistTimer = setTimeout(persistJobs, 5000); }

// after a restart: pick up jobs that are still running on their machines
function resumeJobs() {
  for (const job of Object.values(jobs)) {
    if (job.status !== 'running') continue;
    const m = MACHINES.find((x) => x.id === job.machine);
    if (!m) continue;
    const append = appendTo(job);
    append('\n[dashboard restarted; following the job again]\n');
    log(`job ${job.id}: resuming`);
    (async () => {
      let code;
      try { code = job.remote ? await followDetached(job.machine, job, append) : await followAgentJob(m, job, append); }
      catch (e) { append(`\n${e.message || e}\n`); code = -1; }
      finishJob(job, code);
    })();
  }
}

async function runAgentJob(m, body, append, job) {
  const r = await httpRequest(`${m.agent}/update`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, timeout: 10_000 });
  if (!r.ok) { append(`agent refused: ${r.detail} ${r.body || ''}\n`); return -1; }
  job.agentJob = JSON.parse(r.body).job;
  persistJobs();
  return followAgentJob(m, job, append);
}

async function followAgentJob(m, job, append) {
  const agentJob = job.agentJob;
  let shown = job.agentShown || 0;
  for (;;) {
    await sleep(3000);
    const s = await httpRequest(`${m.agent}/jobs/${encodeURIComponent(agentJob)}`, { timeout: 8000 });
    if (!s.ok) continue;
    const j = JSON.parse(s.body);
    if (j.log && j.log.length > shown) { append(j.log.slice(shown)); shown = j.log.length; job.agentShown = shown; persistJobsSoon(); }
    if (j.status !== 'running') return j.exit_code ?? (j.status === 'ok' ? 0 : 1);
  }
}

// ================================================================ scheduling
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = new Set();

async function refreshMachine(m, mode) {
  const key = `${m.id}:${mode}`;
  if (busy.has(key)) return;
  busy.add(key);
  try {
    if (DEMO) await demo.refresh(m, mode);
    else if (m.reporter === 'mac' || m.reporter === 'pve' || m.reporter === 'linux') await collectReporter(m, mode);
    else if (m.reporter === 'winagent') await collectWinAgent(m, mode);
    if (live.reports[m.id]?.ok) live.reports[m.id].okAt = Date.now();
  } catch (e) {
    log(`refresh ${m.id} failed`, e);
  } finally { busy.delete(key); }
}

function every(ms, fn, initialDelay = 0) {
  const tick = async () => {
    try { await fn(); } catch (e) { log('loop error', e); }
    setTimeout(tick, typeof ms === 'function' ? ms() : ms);
  };
  setTimeout(tick, initialDelay);
}

// ---------------------------------------------------------------- adaptive cadence
// Fast while someone has the page open, slow when nobody is watching, slowest
// on the backup copy while it's on standby. See CADENCE in config.mjs.
const viewers = { last: 0, wall: 0, wokeAt: 0 };
const isViewing = () => Date.now() - viewers.last < 90_000;
const isWall = () => Date.now() - viewers.wall < 90_000;
const cadence = (kind) => () => 1000 * CADENCE[kind][!store.role.active ? 2 : isViewing() ? 0 : isWall() ? (CADENCE[kind][3] ? 3 : 1) : 1];
// kind 'wall' = the always-on /wall screen (or a map embedded in it): medium pace, see CADENCE
function noteViewer(kind = 'person') {
  const wasIdle = !isViewing() && !isWall();
  if (kind === 'wall') viewers.wall = Date.now(); else viewers.last = Date.now();
  if (DEMO) return; // demo data is always fresh
  // first visit after a quiet spell: refresh everything now instead of waiting for the slow timers
  if (wasIdle && Date.now() - viewers.wokeAt > 60_000) {
    viewers.wokeAt = Date.now();
    log('viewer arrived: refreshing everything');
    (async () => { await collectTailscale(); await runProbes(); })().catch(() => {});
    MACHINES.filter((m) => m.reporter).forEach((m) => refreshMachine(m, 'fast').catch(() => {}));
    pingMachines().catch(() => {});
  }
}

const osVersionOf = (d) => d?.versions?.pve || d?.stats?.os?.version || null;

function startLoops() {
  every(cadence('probes'), async () => { await collectTailscale(); await runProbes(); });
  every(() => cadence('probes')() * 2, runSiteChecks, 8_000);
  every(cadence('ping'), pingMachines, 5_000);
  every(60_000, alertLoop, 90_000);
  MACHINES.filter((m) => m.reporter).forEach((m, i) => {
    every(cadence(m.reporter === 'winagent' ? 'agent' : 'reporters'), () => refreshMachine(m, 'fast'), 2_000 + i * 3_000);
    // full update check every 6 h (immediately if we have none or it's old)
    every(10 * MIN, async () => {
      const u = store.updates[m.id];
      const last = u?.checkedAt || 0;
      // an OS upgrade (e.g. PVE 7 -> 9) makes the cached list meaningless: check again right away
      const now = osVersionOf(live.reports[m.id]?.data);
      const upgraded = u && now && u.osVersion !== now;
      if (upgraded) log(`${m.id}: OS version ${u.osVersion || '?'} -> ${now}, re-checking updates`);
      if (Date.now() - last > 6 * HOUR || upgraded) await refreshMachine(m, 'full');
    }, 30_000 + i * 20_000);
  });
  every(10 * MIN, async () => {
    const last = Math.min(...UPSTREAM.map((u) => store.upstream[u.id]?.checkedAt || 0));
    if (Date.now() - last > 6 * HOUR) await checkUpstream();
  }, 15_000);
  if (ROLE === 'standby') every(20_000, roleLoop, 10_000);
  if (ROLE === 'primary' && SERVICE) {
    // Keep svc:status advertised (idempotent; also covers Tailscale coming up after us).
    let advertised = false;
    every(() => (advertised ? 30 * MIN : 2 * MIN), async () => { advertised = await ensureAdvertised(); }, 3_000);
  }
  // systemd watchdog: if the event loop wedges, systemd restarts us
  if (process.env.WATCHDOG_USEC) every(Number(process.env.WATCHDOG_USEC) / 3000, () => run('systemd-notify', ['--pid=' + process.pid, 'WATCHDOG=1'], { timeout: 5000 }));
}

// ================================================================ primary / backup roles
const tsArgs = () => (TS.serviceSocket ? [`--socket=${expand(TS.serviceSocket)}`] : []);
// A Tailscale Service name (e.g. svc:status) = the two-copy failover setup; without it
// this copy is served by a plain `tailscale serve` (or your own proxy) and never advertises.
const SERVICE = INSTANCE.service || (ROLE === 'standby' ? 'svc:status' : null);
// Where browsers reach this dashboard (the web terminal only accepts this origin).
const PUBLIC_ORIGIN = INSTANCE.publicUrl ? new URL(INSTANCE.publicUrl).origin
  : SERVICE ? `https://${SERVICE.replace(/^svc:/, '')}.${INSTANCE.tailnet}` : (ALERTS.url ? new URL(ALERTS.url).origin : null);

// Serving a Unix socket needs root (Tailscale's rule), so with instance.socket the
// service's handler is set once at install time (docs/SETUP.md, "Failover") and
// the app only advertises and drains it, which the Tailscale operator may do.
const tsc = (args, timeout = 30_000) => run(TS.serviceCli || TS.cli, [...tsArgs(), ...args], { timeout });
async function serviceTarget() {
  const r = await tsc(['serve', 'status', '--json'], 15_000);
  try {
    for (const web of Object.values(JSON.parse(r.out).Services?.[SERVICE]?.Web || {})) if (web.Handlers?.['/']?.Proxy) return web.Handlers['/'].Proxy;
  } catch { /* no config yet */ }
  return null;
}
async function ensureAdvertised() {
  const want = SOCKET ? `unix:${SOCKET}` : `http://127.0.0.1:${PORT}`;
  let r = { code: 0, out: '', err: '' };
  if ((await serviceTarget()) !== want) {
    r = await tsc(['serve', `--service=${SERVICE}`, '--https=443', want]);
    if (r.code !== 0 && SOCKET) log(`cannot point ${SERVICE} at the socket as this user; run once as root: tailscale serve --service=${SERVICE} --https=443 ${want}`);
  }
  // `serve advertise` also undoes an earlier `serve drain` (see ExecStopPost in the unit).
  const a = r.code === 0 ? await tsc(['serve', 'advertise', SERVICE]) : r;
  log(`advertise ${SERVICE}: exit ${r.code}/${a.code} ${(a.out + a.err).trim().slice(0, 200)}`);
  return r.code === 0 && a.code === 0;
}
async function withdraw() {
  const d = await tsc(['serve', 'drain', SERVICE]);
  if (SOCKET) { log(`withdraw ${SERVICE}: drained (exit ${d.code}), handler kept`); return d.code === 0; } // re-advertising needs no root
  const r = await tsc(['serve', 'clear', SERVICE]);
  log(`withdraw ${SERVICE}: exit ${r.code} ${(r.out + r.err).trim().slice(0, 300)}`);
  return r.code === 0;
}

// ---- quiet windows (config QUIET_WINDOWS), e.g. the router's nightly restart
const hhmm = (tz, d = new Date()) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
function quietWindow(at = Date.now()) {
  for (const w of QUIET_WINDOWS || []) {
    const t = hhmm(w.tz, new Date(at));
    if (w.start <= w.end ? t >= w.start && t < w.end : t >= w.start || t < w.end) return w;
  }
  return null;
}

const roleState = { fails: 0, oks: 0, last: null };
function rolePeerView() {
  if (!FAILOVER) return null;
  if (ROLE === 'standby') return { name: `Primary (${FAILOVER.primary || INSTANCE.primaryNode})`, healthy: roleState.last?.ok ?? null, detail: roleState.last?.detail || null, at: roleState.last?.at || null };
  // the backup machine's reporter checks the backup app (a reporterConfig port named "Status backup…")
  const rep = live.reports[FAILOVER.backupMachine];
  const r = rep?.data?.ports?.find((p) => p.name.startsWith('Status backup'));
  return { name: `Backup (${FAILOVER.backup || FAILOVER.backupMachine})`, healthy: r ? r.ok : null, detail: r?.detail || 'not checked yet', at: rep?.at || null };
}

// Tailscale's "online" flag only says whether the primary can reach Tailscale's
// coordination server. When the home internet wobbles, both hosts lose that at
// once and taking over helps nobody, so the primary is asked directly, over the
// tailnet and over the LAN. Take over only if it doesn't answer on either, or it
// answers on the LAN but its own Tailscale isn't running.
async function fetchJson(url) {
  if (INSTANCE.lanViaSystemTools && isLan(new URL(url).hostname)) {
    const r = await run('/usr/bin/curl', ['-s', '-m', '5', '-w', '\n%{http_code}', url], { timeout: 9000 });
    const i = r.out.lastIndexOf('\n'); const code = Number(r.out.slice(i + 1));
    return code === 200 ? { ok: true, body: r.out.slice(0, i) } : { ok: false, detail: code ? `HTTP ${code}` : `curl exit ${r.code}` };
  }
  const r = await httpRequest(url, { timeout: 5000 });
  return r.code === 200 ? { ok: true, body: r.body } : { ok: false, detail: r.detail };
}
store.role.primaryLan ??= [];
function syncMarks(m) {
  const before = JSON.stringify([store.acks, store.stopped]);
  store.acks = m.acks || {}; store.stopped = m.stopped || {};
  if (JSON.stringify([store.acks, store.stopped]) !== before) { save(); log(`marks synced from primary: ${Object.keys(store.stopped).length} stopped, ${Object.keys(store.acks).length} hidden`); }
}
async function checkPrimary() {
  const port = INSTANCE.primaryHealthPort || 3901;
  const peer = live.ts.peers[INSTANCE.primaryNode];
  const lan = [...new Set([...(INSTANCE.primaryLan ? [INSTANCE.primaryLan] : []), ...store.role.primaryLan])];
  const paths = [...(peer?.ip ? [['tailnet', peer.ip]] : []), ...lan.map((ip) => ['LAN', ip])];
  const results = await Promise.all(paths.map(async ([via, ip]) => ({ via, ip, ...(await fetchJson(`http://${ip}:${port}/api/health`)) })));
  const good = results.find((r) => r.ok);
  if (good) {
    let h = {}; try { h = JSON.parse(good.body); } catch {}
    if (Array.isArray(h.lan) && h.lan.length && h.lan.join() !== store.role.primaryLan.join()) { store.role.primaryLan = h.lan; save(); }
    if (h.marks && !store.role.active) syncMarks(h.marks);
    const viaTailnet = results.some((r) => r.ok && r.via === 'tailnet');
    if (!viaTailnet && h.tailscale && h.tailscale !== 'Running') return { ok: false, detail: `answers on the LAN but its Tailscale is ${h.tailscale}` };
    const note = h.controlLost || (peer && !peer.online) ? ' (Tailscale coordination server unreachable; internet trouble, not the primary)' : '';
    return { ok: true, detail: `healthy via ${good.via}${note}` };
  }
  if (!paths.length) return { ok: false, detail: `${INSTANCE.primaryNode} not visible in Tailscale and no LAN address known` };
  return { ok: false, detail: `no answer from the primary (${results.map((r) => `${r.via} ${r.ip}: ${r.detail}`).join('; ')})` };
}

async function roleLoop() {
  if (Date.now() - live.ts.at > 25_000) await collectTailscale();
  const res = await checkPrimary();
  roleState.last = { ...res, at: Date.now() };
  if (res.ok) { roleState.oks++; roleState.fails = 0; } else { roleState.fails++; roleState.oks = 0; }
  // the LAN itself drops while the router restarts; don't flip roles over that
  if (!res.ok && quietWindow()) { roleState.fails = 0; return; }
  // take over after 3 failed checks (~1 min); hand back after 6 good ones (~2 min)
  if (!store.role.active && roleState.fails >= 3) {
    if (await ensureAdvertised()) {
      setRole(true, `Primary unreachable (${res.detail}). Backup on ${FAILOVER?.backup || INSTANCE.hostLabel} took over ${SERVICE.replace(/^svc:/, '')}.${INSTANCE.tailnet}.`);
    }
  } else if (store.role.active && roleState.oks >= 6) {
    if (await withdraw()) setRole(false, `Primary on ${FAILOVER?.primary || 'the primary'} is healthy again. Backup handed ${SERVICE.replace(/^svc:/, '')} back and is on standby.`);
  }
}

function setRole(active, message) {
  store.role.active = active;
  store.role.since = Date.now();
  store.role.events.push({ at: Date.now(), active, message });
  store.role.events = store.role.events.slice(-30);
  save();
  log(`ROLE: ${message}`);
  logEvent('failover', { status: active ? 'warn' : 'ok', title: active ? 'Backup took over the dashboard' : 'Primary is serving again', detail: message });
  if (ALERTS.enabled && INSTANCE.notify) run('/bin/bash', [expand(INSTANCE.notify), `Status dashboard: ${message}`], { timeout: 40_000 }).then((r) => log(`notify exit ${r.code}`));
}

// ================================================================ critical alerts (Telegram or a notify script)
// Only the copy that is currently serving sends. An open problem with status
// "down" that isn't hidden or marked stopped on purpose alerts once it has
// lasted ALERTS.afterMin minutes; a recovery message follows when it clears.
store.alerts ??= { open: {}, sent: [] };

async function sendTelegram(text) {
  try {
    if (INSTANCE.notify) {
      const r = await run('/bin/bash', [expand(INSTANCE.notify), text], { timeout: 40_000 });
      if (r.code !== 0) throw new Error(`notify.sh exit ${r.code}`);
    } else if (INSTANCE.telegramTokenFile) {
      const token = fs.readFileSync(expand(INSTANCE.telegramTokenFile), 'utf8').trim();
      const r = await httpRequest(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', timeout: 20_000, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: ALERTS.chatId, text, disable_web_page_preview: true }),
      });
      if (!r.ok) throw new Error(`Telegram HTTP ${r.code}`);
    } else if (DEMO) { log(`demo: would send alert:\n${text}`); }
    else throw new Error('no notification channel configured');
    store.alerts.sent.push({ at: Date.now(), text: text.slice(0, 500), ok: true });
    logEvent('alert', { status: 'ok', title: 'Telegram alert sent', detail: text.split('\n').filter(Boolean).slice(0, 4).join(' · ').slice(0, 300) });
    log('alert sent');
  } catch (e) {
    store.alerts.sent.push({ at: Date.now(), text: text.slice(0, 500), ok: false, error: String(e.message || e) });
    logEvent('alert', { status: 'down', title: 'Telegram alert could not be sent', detail: String(e.message || e).slice(0, 200) });
    log('alert FAILED:', e.message || e);
  }
  store.alerts.sent = store.alerts.sent.slice(-50);
  save();
}

const fmtDuration = (ms) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

function trackProblems(st) {
  const now = Date.now();
  const cur = new Map(st.summary.problems.filter((p) => p.kind !== 'quota').map((p) => [p.key, p]));
  const silenced = new Map([...st.summary.acknowledged.map((p) => [p.key, 'hidden']), ...st.summary.stopped.map((p) => [p.key, 'marked stopped on purpose'])]);
  const nameOf = (id) => st.machines.find((m) => m.id === id)?.name || null;
  for (const [k, p] of cur) {
    const s = store.seen[k];
    if (!s) {
      store.seen[k] = { status: p.status, since: now, name: p.name, machine: p.machine };
      const qw = quietWindow(now);
      logEvent('problem', { status: p.status, title: `${p.name} ${p.status === 'down' ? 'is down' : 'needs attention'}`, detail: qw ? `${p.detail} · during the ${qw.label}` : p.detail, machine: nameOf(p.machine) });
    } else if (s.status !== p.status) {
      logEvent('problem', { status: p.status, title: `${p.name} ${p.status === 'down' ? 'is now down' : 'improved, still needs attention'}`, detail: p.detail, machine: nameOf(p.machine) });
      s.status = p.status;
    }
  }
  for (const [k, s] of Object.entries(store.seen)) {
    if (cur.has(k)) continue;
    delete store.seen[k];
    if (silenced.has(k)) continue; // you hid it / marked it; that's logged separately
    logEvent('recovered', { status: 'ok', title: `${s.name} is OK again`, detail: `was ${s.status === 'down' ? 'down' : 'flagged'} for ${fmtDuration(now - s.since)}`, machine: nameOf(s.machine) });
  }
  save();
}

// Flapping and internet trouble are handled so one bad night isn't 20 messages:
//  - a recovery is only announced after it has stayed OK for RECOVER_HOLD; if it
//    goes down again before that, nothing new is sent (it's still the same outage)
//  - while this host can't reach Tailscale's coordination server (home internet
//    trouble), service alerts are held and one "internet unstable" message goes out
const RECOVER_HOLD = 10 * MIN;
store.alerts.net ??= null;

async function alertLoop() {
  const st = stateView();
  trackProblems(st);
  if (!ALERTS.enabled || !store.role.active) return;
  const now = Date.now();
  if (now - live.ts.at > 60_000) await collectTailscale();
  const lines = [];

  // ---- this host's internet
  const quiet = quietWindow(now);
  const netBad = !!live.ts.controlLost;
  let net = store.alerts.net;
  if (netBad && quiet) { /* expected during the window: say nothing */ }
  else if (netBad) {
    net = store.alerts.net = net || { since: now, notified: false };
    net.okSince = null;
    if (!net.notified && now - net.since >= ALERTS.afterMin * MIN) {
      net.notified = true;
      lines.push(`🟠 Home internet looks unstable: ${INSTANCE.hostLabel} can't reach Tailscale's coordination server. Service alerts are on hold until it settles.`);
    }
  } else if (net) {
    net.okSince ??= now;
    if (now - net.okSince >= RECOVER_HOLD || !net.notified) {
      if (net.notified) lines.push(`✅ Internet is stable again (unstable for ${fmtDuration(net.okSince - net.since)}).`);
      net = store.alerts.net = null;
    }
  }
  const holding = !!quiet || netBad || !!(net?.okSince && now - net.okSince < 2 * MIN); // give tailnet paths a moment to recover

  // ---- services
  let down = st.summary.problems.filter((p) => p.status === 'down' && p.kind !== 'quota');
  // if the dashboard itself lost Tailscale, every tailnet check fails: report only that
  const self = down.find((p) => p.kind === 'self');
  if (self) down = [self];
  const cur = new Map(down.map((p) => [p.key, p]));
  const silenced = new Set([...st.summary.acknowledged.map((p) => p.key), ...st.summary.stopped.map((p) => p.key)]);
  const nameOf = (id) => st.machines.find((m) => m.id === id)?.name || '';
  const fresh = [], recovered = [];
  for (const [k, p] of cur) {
    const a = (store.alerts.open[k] ??= { since: now, notified: false });
    a.okSince = null; // down again inside the hold: same outage, no new message
    Object.assign(a, { name: p.name, where: nameOf(p.machine), detail: p.detail });
    if (holding && !a.notified) a.since = Math.max(a.since, now - (ALERTS.afterMin - 1) * MIN); // re-arm once the internet settles
    else if (!a.notified && now - a.since >= ALERTS.afterMin * MIN) { a.notified = true; fresh.push(a); }
  }
  for (const [k, a] of Object.entries(store.alerts.open)) {
    if (cur.has(k)) continue;
    // hidden/marked by you, or never announced: drop quietly
    if (!a.notified || silenced.has(k)) { delete store.alerts.open[k]; continue; }
    a.okSince ??= now;
    if (now - a.okSince >= RECOVER_HOLD) { recovered.push({ ...a, lasted: a.okSince - a.since }); delete store.alerts.open[k]; }
  }
  if (fresh.length) {
    if (lines.length) lines.push('');
    lines.push(`🔴 Home lab: ${fresh.length === 1 ? 'something is down' : `${fresh.length} things are down`}`);
    for (const a of fresh.slice(0, 8)) lines.push(`• ${a.name}${a.where && !a.name.includes(a.where) ? ` (${a.where})` : ''}: ${a.detail.slice(0, 140)}`);
    if (fresh.length > 8) lines.push(`• …and ${fresh.length - 8} more`);
  }
  if (recovered.length) {
    if (lines.length) lines.push('');
    lines.push(`✅ Back up: ${recovered.map((a) => `${a.name} (down ${fmtDuration(a.lasted)})`).join(', ')}`);
  }
  if (lines.length) {
    lines.push('', ALERTS.url);
    await sendTelegram(lines.join('\n'));
  } else save();
}

// ================================================================ sites page
const siteChecks = {}; // index -> result for sites with their own check
async function runSiteChecks() {
  if (DEMO) return;
  await Promise.all(SITES.map(atGuest).map(async (s, i) => {
    if (!s.check || typeof s.check === 'string') return;
    const viaSys = !!INSTANCE.lanViaSystemTools && isLan(new URL(s.check.url).hostname);
    const r = viaSys ? await curlProbe(s.check.url, s.check.insecure) : await httpRequest(s.check.url, { insecure: s.check.insecure, timeout: 8000 });
    if (r.code) r.ok = s.check.expect ? s.check.expect.includes(r.code) : r.code < 500;
    siteChecks[i] = { ok: r.ok, code: r.code, ms: r.ms, detail: r.detail, at: Date.now() };
  }));
}
function sitesView() {
  return SITES.map(atGuest).map((s, i) => {
    let r = null;
    if (typeof s.check === 'string') r = live.probes[s.check] ? { ...live.probes[s.check] } : null;
    else if (s.check) r = siteChecks[i] || null;
    const stoppedOnPurpose = typeof s.check === 'string' && store.stopped[`probe:${s.check}`];
    const status = !s.check ? 'link' : !r ? 'unknown' : r.ok ? 'ok' : stoppedOnPurpose ? 'off' : 'down';
    return { group: s.group, name: s.name, url: s.url, note: s.note, status, detail: stoppedOnPurpose && !r?.ok ? 'Stopped on purpose' : r?.detail || null, ms: r?.ms ?? null, at: r?.at || null };
  });
}

// Content fingerprint of what the browser runs: the /wall screen reloads itself
// when a deploy changes it (same files on both copies = same value, so a
// failover doesn't trigger a reload).
const BUILD = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['public/index.html', 'public/app.js', 'public/maps.js', 'public/style.css', 'public/wall.html', 'public/wall.js', 'public/wall.css', MAPS_FILE, CONFIG_FILE]) {
    try { h.update(fs.readFileSync(path.join(ROOT, f))); } catch { /* missing file */ }
  }
  return h.digest('hex').slice(0, 12);
})();

// ================================================================ maps page
// Each map node names how to find its live status (see maps.mjs); this
// resolves those against the same state the overview shows.
const SEV = { down: 5, warn: 4, unknown: 3, off: 2, ok: 1 };
function mapsView(withDefs = true) {
  const st = stateView();
  const machines = new Map(st.machines.map((m) => [m.id, m]));
  const services = new Map(st.services.map((s) => [s.id, s]));
  const guests = new Map((machines.get(PVE_ID)?.guests || []).map((g) => [g.vmid, g]));
  const devChecks = machines.get(PVE_ID)?.checks || [];
  const one = (b) => {
    if (b.machine) {
      const m = machines.get(b.machine); if (!m) return null;
      const st2 = m.stats;
      const facts = m.status === 'ok' && st2 ? [st2.cpu_percent != null && `CPU ${Math.round(st2.cpu_percent)}%`, st2.mem?.total_bytes && `memory ${Math.round((100 * st2.mem.used_bytes) / st2.mem.total_bytes)}%`, m.collectedAt && `stats ${fmtAgo(new Date(m.collectedAt).toISOString())}`].filter(Boolean).join(' · ') : '';
      return { status: m.status, detail: `${m.name}: ${facts || m.reason}` };
    }
    if (b.checkGroup) {
      const [mid, group] = b.checkGroup; const cs = (machines.get(mid)?.checks || []).filter((x) => x.group === group);
      if (!cs.length) return null;
      const bad = cs.filter((x) => x.status !== 'ok' && x.status !== 'off');
      const active = cs.filter((x) => x.status !== 'off'); // stopped on purpose doesn't make the group look off
      const worst = (active.length ? active : cs).reduce((a, c) => ((SEV[c.status] || 0) > (SEV[a.status] || 0) ? c : a));
      return { status: worst.status, detail: bad.length ? bad.map((x) => `${x.name}: ${x.detail || x.status}`).join('; ') : `${group}: ${active.length} OK${cs.length > active.length ? ` · ${cs.length - active.length} stopped on purpose` : ''}` };
    }
    if (b.quota) {
      const accts = st.quota.accounts.filter((a) => a.provider === b.quota); if (!accts.length) return null;
      const worst = accts.reduce((a, c) => ((SEV[c.status] || 0) > (SEV[a.status] || 0) ? c : a));
      return { status: worst.status, detail: accts.map((a) => `${a.account}: ${a.statusLabel || a.status}${a.lowest ? ` (${a.lowest.label} ${a.lowest.left}% left)` : ''}`).join(' · ') };
    }
    if (b.probe) { const s = services.get(b.probe); return s ? { status: s.status, detail: `${s.name}: ${s.detail}` } : null; }
    if (b.check) {
      const [mid, name] = b.check; const c = machines.get(mid)?.checks?.find((x) => x.name === name);
      return c ? { status: c.status, detail: `${c.name}: ${c.detail || c.status}` } : null;
    }
    if (b.guest) {
      const g = guests.get(b.guest); if (!g) return null;
      const c = devChecks.find((x) => x.group === 'Guests' && new RegExp(`\\((CT|VM) ${b.guest}\\)`).test(x.name));
      if (g.status === 'running') return { status: 'ok', detail: `${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid}: running` };
      return { status: c?.status || (g.onboot === false ? 'off' : 'down'), detail: `${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid}: ${c?.detail || g.status}` };
    }
    // a phone or laptop that is simply asleep is "off", not an outage
    if (b.ts) { const p = live.ts.peers[b.ts]; return p ? { status: p.online ? 'ok' : 'off', detail: `${b.ts}: ${p.online ? 'online' : `offline since ${fmtAgo(p.lastSeen)}`} in Tailscale` } : null; }
    return null;
  };
  const status = {};
  const missing = [];
  for (const map of MAPS) {
    const out = (status[map.id] = {});
    for (const n of map.nodes) {
      if (!n.bind) continue;
      const parts = (Array.isArray(n.bind) ? n.bind : [n.bind]).map((b) => { const r = one(b); if (!r) missing.push(`${map.id}/${n.id}: ${JSON.stringify(b)}`); return r; }).filter(Boolean);
      if (!parts.length) { out[n.id] = { status: 'unknown', details: ['not reported yet'] }; continue; }
      const worst = parts.reduce((a, b) => ((SEV[b.status] || 0) > (SEV[a.status] || 0) ? b : a));
      out[n.id] = { status: worst.status, details: parts.map((p) => p.detail) };
    }
  }
  return { generatedAt: Date.now(), status, missing, ...(withDefs ? { maps: MAPS } : {}) };
}

// ================================================================ web terminal (WebSocket, no deps)
// Browser (xterm.js) <-> WebSocket <-> ptybridge.py <-> ssh -tt <target>.
// Only the owner's Tailscale identity, only from this page's origin.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TERM_MAX = 4, TERM_IDLE_MS = 30 * MIN;
const terms = new Map();
store.audit ??= [];

function wsFrame(data, opcode = 2) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
}
function wsParser(onMessage, onClose) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { onClose(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
      if (masked) { const mask = buf.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
      buf = buf.subarray(need);
      if (op === 8) { onClose(); return; }
      if (op === 1 || op === 2) onMessage(op, payload);
    }
  };
}

function handleTerminal(req, sock) {
  const fail = (code, msg) => { try { sock.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* ignore */ } sock.destroy(); };
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/api/term') return fail(404, 'Not Found');
  const who = caller(req);
  if (!who || !OWNER_LOGINS.includes(who)) return fail(403, 'Forbidden');
  if (!store.role.active) return fail(409, 'Conflict'); // only the copy that is serving opens shells
  if (!PUBLIC_ORIGIN || (req.headers.origin || '') !== PUBLIC_ORIGIN) return fail(403, 'Forbidden');
  if (terms.size >= TERM_MAX) return fail(429, 'Too Many Requests');
  const machineId = url.searchParams.get('machine') || '';
  const access = INSTANCE.access[machineId];
  const t = access && terminalTargetsFor(machineId, { data: live.reports[machineId]?.data }).find((x) => x.id === url.searchParams.get('target'));
  if (!t) return fail(404, 'Not Found');
  const key = req.headers['sec-websocket-key'];
  if (!key) return fail(400, 'Bad Request');
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);

  const py = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';
  const bridge = path.join(ROOT, 'term/ptybridge.py');
  const localShell = process.platform === 'darwin' ? '/bin/zsh' : (process.env.SHELL || '/bin/bash');
  const args = access.local ? [bridge, localShell, '-l']
    : [bridge, 'ssh', '-tt', '-i', SSH_KEY, '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', '-o', 'ConnectTimeout=8', access.ssh, ...(t.remote ? [t.remote] : [])];
  const child = spawn(py, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { ...process.env, TERM: 'xterm-256color' } });
  const id = crypto.randomUUID().slice(0, 8);
  const session = { id, who, machine: machineId, target: t.label, start: Date.now(), last: Date.now() };
  terms.set(id, session);
  log(`terminal ${id}: ${who} opened ${machineId} / ${t.label}`);
  logEvent('terminal', { status: 'info', title: `Terminal opened: ${t.label}`, machine: MACHINES.find((x) => x.id === machineId)?.name, who });
  store.audit.push({ kind: 'terminal', id, who, machine: machineId, target: t.label, start: session.start, end: null });
  store.audit = store.audit.slice(-200); save();

  let closed = false;
  const finish = (why) => {
    if (closed) return; closed = true;
    clearInterval(idleTimer);
    terms.delete(id);
    try { child.kill('SIGHUP'); } catch { /* gone */ }
    try { sock.write(wsFrame(Buffer.alloc(0), 8)); } catch { /* gone */ }
    sock.end();
    const a = store.audit.find((x) => x.id === id); if (a) a.end = Date.now();
    save();
    log(`terminal ${id}: closed (${why})`);
    logEvent('terminal', { status: 'info', title: `Terminal closed: ${t.label}`, detail: `${why} · ${fmtDuration(Date.now() - session.start)}`, machine: MACHINES.find((x) => x.id === machineId)?.name, who });
  };
  const send = (d) => { if (!closed) { session.last = Date.now(); sock.write(wsFrame(d, 2)); } };
  child.stdout.on('data', send);
  child.stderr.on('data', send);
  child.on('close', (code) => { send(`\r\n\x1b[2m[session ended${code ? `, exit ${code}` : ''}]\x1b[0m\r\n`); finish('process exited'); });
  child.stdin.on('error', () => {});
  child.stdio[3].on('error', () => {});
  sock.on('data', wsParser((op, payload) => {
    session.last = Date.now();
    if (op === 2) { child.stdin.write(payload); return; }
    try {
      const j = JSON.parse(payload.toString());
      if (j.type === 'resize') child.stdio[3].write(`resize ${j.cols | 0} ${j.rows | 0}\n`);
    } catch { /* ignore bad control frames */ }
  }, () => finish('client closed')));
  sock.on('close', () => finish('socket closed'));
  sock.on('error', () => finish('socket error'));
  const idleTimer = setInterval(() => {
    if (Date.now() - session.last > TERM_IDLE_MS) { send('\r\n\x1b[2m[closed after 30 minutes idle]\x1b[0m\r\n'); finish('idle'); }
  }, 30_000);
}

// ================================================================ HTTP
function httpError(status, message) { return Object.assign(new Error(message), { status }); }

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/sites': ['public/index.html', 'text/html; charset=utf-8'],
  '/maps': ['public/index.html', 'text/html; charset=utf-8'],
  '/maps.js': ['public/maps.js', 'text/javascript; charset=utf-8'],
  '/wall': ['public/wall.html', 'text/html; charset=utf-8'],
  '/wall.js': ['public/wall.js', 'text/javascript; charset=utf-8'],
  '/wall.css': ['public/wall.css', 'text/css; charset=utf-8'],
  '/vendor/xterm.js': ['public/vendor/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': ['public/vendor/xterm.css', 'text/css; charset=utf-8'],
  '/vendor/addon-fit.js': ['public/vendor/addon-fit.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN', // only the dashboard's own /wall may frame it
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'self'",
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > limit) { reject(httpError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(httpError(400, 'invalid JSON')); } });
  });
}

// Who is asking. `tailscale serve` adds Tailscale-User-Login for requests from
// user-owned devices; tagged devices get none.
// Any local process (or a Docker container reaching the host's loopback) could
// send that header to the TCP port too. With instance.socket set, `tailscale
// serve` proxies to a Unix socket only this user (and root's tailscaled) can open,
// and the identity is believed only on that socket; TCP stays for health checks
// and read-only views.
const SOCKET = INSTANCE.socket ? expand(INSTANCE.socket) : null;
const trusted = (req) => !SOCKET || req.socket.viaUnixSocket === true;
function caller(req) {
  return trusted(req) ? req.headers['tailscale-user-login'] || null : null;
}
function requireOwner(req) {
  // Browsers can't send this custom header cross-origin without a CORS
  // preflight, which we never approve: blocks CSRF from other pages.
  if (req.headers['x-status-ui'] !== '1') throw httpError(403, 'missing X-Status-UI header');
  const who = caller(req);
  if (!who && INSTANCE.allowAnonymousActions) return 'local';
  if (!who || !OWNER_LOGINS.includes(who)) throw httpError(403, `updates are only allowed for ${OWNER_LOGINS.join(', ')} (you are ${who || 'not identified by Tailscale'})`);
  return who;
}

const handle = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(ROOT, file)), type);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, role: ROLE, active: store.role.active, build: BUILD });
    if (req.method === 'GET' && url.pathname === '/api/maps') {
      noteViewer(url.searchParams.has('wall') ? 'wall' : 'person');
      return send(res, 200, mapsView(url.searchParams.get('defs') !== '0'));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      noteViewer(url.searchParams.has('wall') ? 'wall' : 'person');
      return send(res, 200, { ...stateView(), viewer: caller(req), sites: sitesView(), polling: { viewing: isViewing() ? 'person' : isWall() ? 'wall' : 'none', intervals: Object.fromEntries(Object.keys(CADENCE).map((k) => [k, cadence(k)() / 1000])) } });
    }
    let m;
    if (req.method === 'GET' && (m = /^\/api\/jobs\/([a-f0-9-]{1,40})$/.exec(url.pathname))) {
      const j = jobs[m[1]];
      if (!j) return send(res, 404, { error: 'no such job' });
      const since = Number(url.searchParams.get('since') || 0);
      return send(res, 200, { ...jobSummary(j), log: j.log.slice(since), logLength: j.log.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const who = requireOwner(req);
      const body = await readBody(req);
      const job = await startAction(String(body.machine || ''), String(body.action || ''), body.confirm == null ? null : String(body.confirm), who);
      return send(res, 202, { job: job.id });
    }
    if (req.method === 'POST' && (url.pathname === '/api/ack' || url.pathname === '/api/unack')) {
      const who = requireOwner(req);
      const body = await readBody(req);
      const key = String(body.key || '');
      if (!key || key.length > 300) throw httpError(400, 'missing key');
      return send(res, 200, setAck(key, url.pathname === '/api/ack', who));
    }
    if (req.method === 'POST' && url.pathname === '/api/stopped') {
      const who = requireOwner(req);
      const body = await readBody(req);
      const key = String(body.key || '');
      if (!key || key.length > 300) throw httpError(400, 'missing key');
      return send(res, 200, setStopped(key, body.on !== false, who));
    }
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      requireOwner(req);
      const body = await readBody(req);
      const targets = body.machine ? MACHINES.filter((x) => x.id === body.machine) : MACHINES.filter((x) => x.reporter);
      const mode = body.updates ? 'full' : 'fast';
      Promise.all(targets.map((t) => refreshMachine(t, mode))).then(() => (body.updates ? checkUpstream() : null)).catch(() => {});
      runProbes().catch(() => {});
      return send(res, 202, { ok: true, refreshing: targets.map((t) => t.id), mode });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message || String(e) });
    if (!e.status) log('request error', e);
  }
};
const upgrade = (req, sock) => {
  try { handleTerminal(req, sock); } catch (e) { log('terminal error', e); sock.destroy(); }
};

// 127.0.0.1 by default: `tailscale serve` (or your reverse proxy) is the front door.
const LISTEN = INSTANCE.listen || '127.0.0.1';
const server = http.createServer(handle).on('upgrade', upgrade);
server.listen(PORT, LISTEN, () => log(DEMO ? `demo running: http://localhost:${PORT}  (wall screen: http://localhost:${PORT}/wall)` : `status dashboard (${ROLE}) listening on ${LISTEN}:${PORT}${SOCKET ? ` and ${SOCKET}` : ''}`));
if (SOCKET) {
  const sockServer = http.createServer(handle).on('upgrade', upgrade);
  sockServer.on('connection', (c) => { c.viaUnixSocket = true; });
  try { fs.unlinkSync(SOCKET); } catch { /* not there */ }
  const old = process.umask(0o177); // created 0600: only this user (and root) can connect
  sockServer.listen(SOCKET, () => { process.umask(old); fs.chmodSync(SOCKET, 0o600); });
}

// The primary exposes a health-only port so the backup can check it over the tailnet.
function lanIps() {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal && isLan(a.address)).map((a) => a.address);
}
function healthPayload() {
  // the backup mirrors what you hid / marked stopped here, so it doesn't alert on them after a takeover
  const strip = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, { status: v.status, name: v.name, at: v.at, lastSeen: v.lastSeen }]));
  return { ok: true, role: ROLE, active: store.role.active, lan: lanIps(), tailscale: live.ts.backend || null, controlLost: !!live.ts.controlLost, marks: { acks: strip(store.acks), stopped: strip(store.stopped) } };
}
if (INSTANCE.healthListen) {
  http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, healthPayload());
    send(res, 404, { error: 'not found' });
  }).listen(INSTANCE.healthListen.port, INSTANCE.healthListen.host, () => log(`health listener on ${INSTANCE.healthListen.host}:${INSTANCE.healthListen.port}`));
}

process.on('SIGTERM', () => { persistJobs(); setTimeout(() => process.exit(0), 2500); });
// one-time backfill of the activity log from what was recorded before it existed
if (!store.eventsBackfilled) {
  const old = [];
  for (const j of Object.values(jobs)) {
    old.push({ at: j.startedAt, kind: 'job', status: 'running', title: `Started: ${j.label}`, machine: j.machineName, who: j.who, job: j.id, machineId: j.machine });
    if (j.finishedAt) old.push({ at: j.finishedAt, kind: 'job', status: j.status === 'ok' ? 'ok' : 'down', title: `${j.status === 'ok' ? 'Finished' : 'Failed'}: ${j.label}`, detail: `exit ${j.exitCode} · ${fmtDuration(j.finishedAt - j.startedAt)}`, machine: j.machineName, job: j.id, machineId: j.machine });
  }
  for (const e of store.role.events || []) old.push({ at: e.at, kind: 'failover', status: e.active ? 'warn' : 'ok', title: e.active ? 'Backup took over the dashboard' : 'Primary is serving again', detail: e.message });
  for (const s of store.alerts?.sent || []) old.push({ at: s.at, kind: 'alert', status: s.ok ? 'ok' : 'down', title: s.ok ? 'Telegram alert sent' : 'Telegram alert could not be sent', detail: (s.text || s.error || '').split('\n').filter(Boolean).slice(0, 4).join(' · ').slice(0, 300) });
  for (const a of store.audit || []) {
    old.push({ at: a.start, kind: 'terminal', status: 'info', title: `Terminal opened: ${a.target}`, machine: MACHINES.find((x) => x.id === a.machine)?.name, who: a.who });
    if (a.end) old.push({ at: a.end, kind: 'terminal', status: 'info', title: `Terminal closed: ${a.target}`, machine: MACHINES.find((x) => x.id === a.machine)?.name, who: a.who });
  }
  store.events = [...old.map((e) => ({ id: crypto.randomUUID().slice(0, 8), ...e })), ...store.events].sort((x, y) => x.at - y.at).slice(-500);
  store.eventsBackfilled = true;
  store.events = store.events.filter((e, i, arr) => !(e.kind === 'system' && arr[i + 1]?.kind === 'system' && arr[i + 1].at - e.at < 30 * MIN));
  save();
}
// one-time: recompute durations of early job entries (they were saved with a coarse format)
if (!store.eventsDurationsFixed) {
  for (const e of store.events) {
    const j = e.kind === 'job' && e.status !== 'running' && jobs[e.job];
    if (j?.finishedAt) e.detail = `exit ${j.exitCode} · ${fmtDuration(j.finishedAt - j.startedAt)}`;
  }
  store.eventsDurationsFixed = true; save();
}
const demo = DEMO ? await import('./demo/demo.mjs') : null;
if (DEMO) { demo.start({ live, store, MACHINES, PROBES, UPSTREAM, GUEST_TS, SITES, save, logEvent, pushHistory, siteChecks, osVersionOf }); every(15_000, alertLoop, 4_000); }
else { startLoops(); resumeJobs(); }
{ // fold restarts within 30 min into one entry (deploys restart it often)
  const last = store.events[store.events.length - 1];
  if (last?.kind === 'system' && Date.now() - last.at < 30 * MIN) { last.at = Date.now(); last.count = (last.count || 1) + 1; last.detail = `restarted ${last.count} times in the last half hour`; save(); }
  else logEvent('system', { status: 'info', title: `Dashboard started (${DEMO ? 'demo' : `${ROLE} on ${INSTANCE.hostLabel || os.hostname()}`})` });
}
