// Demo mode: `node server.mjs --demo`. Feeds the dashboard believable, moving
// data for the fictional lab in examples/config.mjs, in exactly the shapes the
// real reporters produce. Nothing is contacted, nothing runs.
//
//   DEMO_INCIDENTS=0   no simulated outages (everything stays green)
//
// Every few minutes one service goes down for a while, so problems, the
// activity log, the maps' impact view and the /wall alert takeover can be seen.

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const GB = 1e9, TB = 1e12;
const INCIDENTS = process.env.DEMO_INCIDENTS !== '0';
const now = () => Date.now();
const sec = (ms) => Math.floor(ms / 1000);

// smooth, deterministic-ish wobble per key: base ± amp, drifting over minutes
const seeds = new Map();
function wave(key, base, amp, periodMin = 7) {
  if (!seeds.has(key)) seeds.set(key, Math.random() * 1000);
  const s = seeds.get(key), t = now() / MIN;
  const v = base + amp * (0.6 * Math.sin(t / periodMin * 2 * Math.PI + s) + 0.3 * Math.sin(t / (periodMin * 0.37) + s * 2) + 0.1 * (Math.random() * 2 - 1));
  return Math.max(0, Math.round(v * 10) / 10);
}
const jitter = (base, spread) => Math.max(1, Math.round(base + (Math.random() * 2 - 1) * spread));

// ---------------------------------------------------------------- fixtures
const BOOT = now() - 23 * DAY - 4 * HOUR;
const GUESTS = [
  { vmid: 100, type: 'qemu', name: 'homeassistant', cpus: 2, maxmem: 4, mem: 2.6, disk: 32, cpu: 3, ip: null },
  { vmid: 101, type: 'qemu', name: 'truenas', cpus: 4, maxmem: 16, mem: 14.8, disk: 32, cpu: 4, ip: '192.168.1.20' },
  { vmid: 102, type: 'lxc', name: 'pihole', cpus: 1, maxmem: 0.5, mem: 0.09, disk: 4, used: 1.8, cpu: 1, ip: '192.168.1.53' },
  { vmid: 103, type: 'lxc', name: 'jellyfin', cpus: 4, maxmem: 6, mem: 1.9, disk: 24, used: 9.1, cpu: 6, ip: '192.168.1.31' },
  { vmid: 104, type: 'lxc', name: 'vaultwarden', cpus: 1, maxmem: 1, mem: 0.12, disk: 8, used: 2.2, cpu: 0.5, ip: '192.168.1.32' },
  { vmid: 105, type: 'lxc', name: 'immich', cpus: 4, maxmem: 8, mem: 3.4, disk: 40, used: 17.5, cpu: 8, ip: '192.168.1.33' },
  { vmid: 106, type: 'lxc', name: 'status', cpus: 1, maxmem: 1, mem: 0.16, disk: 8, used: 2.6, cpu: 1, ip: '192.168.1.34' },
  { vmid: 107, type: 'lxc', name: 'paperless', cpus: 2, maxmem: 3, mem: 1.2, disk: 16, used: 6.3, cpu: 2, ip: '192.168.1.35' },
  { vmid: 108, type: 'qemu', name: 'win11', cpus: 4, maxmem: 8, mem: 0, disk: 80, cpu: 0, stopped: true },
];
const GUEST_DOCKER = [
  { vmid: 105, name: 'immich_server' }, { vmid: 105, name: 'immich_machine_learning' }, { vmid: 105, name: 'immich_postgres' }, { vmid: 105, name: 'immich_redis' },
  { vmid: 107, name: 'paperless-webserver-1' }, { vmid: 107, name: 'paperless-broker-1' }, { vmid: 107, name: 'paperless-gotenberg-1' },
];
const VERSIONS = {
  pve: { 'pihole-ftl': 'v6.3', jellyfin: '10.11.2', pve: '9.1.4' },
  studio: { ollama: '0.13.0', 'open-webui': '0.6.40' },
};
const LATEST = { jellyfin: '10.11.3', 'pihole-ftl': '6.3', 'open-webui': '0.6.40', ollama: '0.13.1' };

// Tailscale nodes the example config and maps refer to
const TS_NODES = {
  pve: '100.64.0.10', 'mac-studio': '100.64.0.12', 'mac-mini': '100.64.0.13', 'gaming-pc': '100.64.0.14', 'macbook-air': '100.64.0.15',
  vps: '100.64.0.20', phone: '100.64.0.16', 'parents-pi': '100.64.0.30', jellyfin: '100.64.0.31', immich: '100.64.0.33', 'status-primary': '100.64.0.34',
};
const OFFLINE = { 'gaming-pc': 5 * HOUR, phone: 40 * MIN }; // asleep / off, which is normal for them

// Simulated outages: [probe id, detail, also affects]
const INCIDENT_LIST = [
  { probe: 'immich', detail: 'connection refused', container: 'immich_server', minutes: 2.5 },
  { probe: 'jellyfin', detail: 'timeout after 6s', service: 'Jellyfin server', minutes: 2 },
  { probe: 'homebridge', detail: 'HTTP 502', launchd: 'com.homebridge.server', minutes: 2 },
];
let incident = null; // { ...def, until }
let nextIncidentAt = now() + Number(process.env.DEMO_FIRST_INCIDENT_MIN ?? 3) * MIN; // DEMO_FIRST_INCIDENT_MIN=0: right away

let ctx;

export function start(c) {
  ctx = c;
  seedStore();
  tick();
  setInterval(tick, 5_000);
}

// "Refresh" in the UI: a short pause so the spinner shows, then fresh numbers
export async function refresh(m) {
  await new Promise((r) => setTimeout(r, 700 + Math.random() * 600));
  collect(m);
}

// Update and control buttons: a believable log, then success. Nothing runs.
export async function runJob(job, action, append) {
  const lines = action.id?.startsWith('apt') ? [
    'Hit:1 http://deb.debian.org/debian trixie InRelease', 'Get:2 http://security.debian.org trixie-security InRelease [43.4 kB]',
    'Reading package lists... Done', 'Calculating upgrade... Done', 'The following packages will be upgraded:', '  libssl3t64 openssl tzdata',
    '3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.', 'Unpacking openssl (3.5.4-1~deb13u1) over (3.5.1-1) ...', 'Setting up openssl (3.5.4-1~deb13u1) ...', 'Processing triggers for libc-bin ...',
  ] : action.id === 'brew' ? [
    '==> Upgrading 4 outdated packages:', 'git 2.51.0 -> 2.51.1', 'node 24.10.0 -> 24.11.0', '==> Pouring git--2.51.1.arm64_tahoe.bottle.tar.gz', '==> Pouring node--24.11.0.arm64_tahoe.bottle.tar.gz', '==> Cleaning up',
  ] : ['(demo) this would run on the machine now', `${action.label}`, 'done'];
  append('(demo mode: nothing is actually run)\n');
  for (const l of lines) { await new Promise((r) => setTimeout(r, 350 + Math.random() * 500)); append(`${l}\n`); }
  if (action.id?.startsWith('apt-')) {
    const u = ctx.store.updates.pve;
    if (action.id === 'apt-host') u.host.items = [];
    else delete u.guests[action.id.replace('apt-ct-', '')];
  }
  if (action.id === 'brew') ctx.store.updates[job.machine].brew.items = [];
  return 0;
}

// ---------------------------------------------------------------- the loop
function tick() {
  const { live } = ctx;
  // incidents
  if (INCIDENTS) {
    if (incident && now() > incident.until) incident = null;
    if (!incident && now() > nextIncidentAt) {
      const def = INCIDENT_LIST[Math.floor(Math.random() * INCIDENT_LIST.length)];
      incident = { ...def, until: now() + def.minutes * MIN };
      nextIncidentAt = incident.until + (5 + Math.random() * 4) * MIN;
    }
  }
  // tailscale
  const peers = {};
  for (const [name, ip] of Object.entries(TS_NODES)) {
    const off = OFFLINE[name];
    peers[name] = { host: name, ip, online: !off, lastSeen: new Date(now() - (off || 0)).toISOString(), exitNode: name === 'vps', routes: name === 'pve' ? ['192.168.1.0/24'] : [], os: 'linux', tags: [] };
  }
  live.ts = { at: now(), peers, self: 'status-primary', error: null, backend: 'Running', controlLost: false, health: [] };
  for (const m of ctx.MACHINES) {
    if (!m.ts) continue;
    live.pings[m.ts] = peers[m.ts]?.online ? { at: now(), ms: m.site === 'Cloud' ? jitter(38, 6) : m.site === 'On the go' ? jitter(24, 10) : jitter(3, 2), via: 'direct', error: null } : { at: now(), ms: null, error: 'offline' };
  }
  // probes
  for (const p of ctx.PROBES) {
    const down = incident?.probe === p.id;
    const machineOff = p.machine && ctx.MACHINES.find((m) => m.id === p.machine)?.optional && OFFLINE[ctx.MACHINES.find((m) => m.id === p.machine)?.ts];
    let r;
    if (down) r = { ok: false, code: null, ms: 6000, detail: incident.detail };
    else if (machineOff) r = { ok: false, code: null, ms: 4000, detail: 'timeout' };
    else if (p.type === 'tailscale') {
      const peer = peers[p.node];
      r = { ok: true, detail: `online · ${[p.exitNode ? 'exit node' : '', ...(p.routes || []).map((x) => `routes ${x}`)].filter(Boolean).join(' · ') || 'reachable'} (${peer?.ip})` };
    } else if (p.type === 'dns') r = { ok: true, ms: jitter(4, 2), detail: `resolved ${p.query}` };
    else if (p.type === 'tcp') r = { ok: true, ms: jitter(3, 2), detail: 'port open' };
    else {
      const code = p.expect?.includes(401) && p.id === 'ha' ? 401 : 200;
      r = { ok: true, code, ms: jitter(p.id === 'caddy' ? 64 : 18, 10), detail: code === 401 ? 'HTTP 401 (token required, up)' : 'HTTP 200' };
    }
    live.probes[p.id] = { ...r, at: now() };
  }
  ctx.SITES.forEach((s, i) => { if (s.check && typeof s.check === 'object') ctx.siteChecks[i] = { ok: true, code: 200, ms: jitter(22, 8), detail: 'HTTP 200', at: now() }; });
  // reporters, every ~15 s each
  for (const m of ctx.MACHINES) if (m.reporter && (!live.reports[m.id] || now() - live.reports[m.id].at > 15_000)) collect(m);
}

function collect(m) {
  const { live } = ctx;
  if (m.optional && OFFLINE[m.ts]) {
    const prev = live.reports[m.id] || {};
    live.reports[m.id] = { ...prev, at: now(), ok: false, fails: 3, error: 'connect timeout (the PC is off)', ms: 5000 };
    return;
  }
  const data = m.reporter === 'pve' ? pveReport(m) : m.reporter === 'mac' ? macReport(m) : m.reporter === 'linux' ? linuxReport(m) : winReport(m);
  live.reports[m.id] = { at: now(), okAt: now(), ok: true, data, error: null, ms: jitter(m.reporter === 'pve' ? 2400 : 900, 300), disksAt: now() };
  ctx.pushHistory(m.id, data.stats);
}

// ---------------------------------------------------------------- reporters
function pveReport(m) {
  const cpu = wave('pve-cpu', 14, 9);
  return {
    ok: true, mode: 'fast', collected_at: sec(now()),
    stats: {
      hostname: 'pve', os: { name: 'Proxmox VE', version: VERSIONS.pve.pve, kernel: '6.17.2-1-pve' }, cpu_name: 'AMD Ryzen 7 7840HS', cores: 16,
      cpu_percent: cpu, load: [cpu / 8, cpu / 9, cpu / 10].map((x) => Math.round(x * 100) / 100), uptime_s: sec(now() - BOOT),
      mem: { total_bytes: 64 * GB, used_bytes: Math.round((38 + wave('pve-mem', 0, 1.5)) * GB) }, swap: { total_bytes: 8 * GB, used_bytes: 0.4 * GB },
      disks: [{ mount: '/', total_bytes: 98 * GB, used_bytes: 21 * GB }], iowait_percent: wave('pve-io', 1.2, 0.8),
    },
    guests: GUESTS.map((g) => ({
      vmid: g.vmid, type: g.type, name: g.name, status: g.stopped ? 'stopped' : 'running', onboot: !g.stopped, ip: g.ip,
      cpu_percent: g.stopped ? 0 : wave(`g${g.vmid}`, g.cpu, g.cpu * 0.7), cpus: g.cpus,
      mem_bytes: Math.round(g.mem * (g.stopped ? 0 : 1 + wave(`gm${g.vmid}`, 0, 0.04)) * GB), maxmem_bytes: g.maxmem * GB,
      disk_bytes: g.used ? g.used * GB : null, maxdisk_bytes: g.disk * GB, uptime_s: g.stopped ? 0 : sec(now() - BOOT + 60_000),
    })),
    storage: [
      { name: 'local', type: 'dir', active: true, used_bytes: 21 * GB, total_bytes: 98 * GB },
      { name: 'local-zfs', type: 'zfspool', active: true, used_bytes: 214 * GB, total_bytes: 1.8 * TB },
      { name: 'tank-backups', type: 'nfs', active: true, used_bytes: 1.9 * TB, total_bytes: 6 * TB },
    ],
    disks: [
      { dev: '/dev/nvme0n1', model: 'Samsung_SSD_990_PRO_2TB', type: 'nvme', health: 'PASSED', size_bytes: 2 * TB, wearout: 97 },
      { dev: '/dev/sda', model: 'WDC_WD80EFPX', type: 'hdd', health: 'PASSED', size_bytes: 8 * TB, wearout: 'N/A' },
      { dev: '/dev/sdb', model: 'WDC_WD80EFPX', type: 'hdd', health: 'PASSED', size_bytes: 8 * TB, wearout: 'N/A' },
      { dev: '/dev/sdc', model: 'WDC_WD80EFPX', type: 'hdd', health: 'PASSED', size_bytes: 8 * TB, wearout: 'N/A' },
      { dev: '/dev/sdd', model: 'WDC_WD80EFPX', type: 'hdd', health: 'PASSED', size_bytes: 8 * TB, wearout: 'N/A' },
    ],
    guest_services: (m.reporterConfig.guest_services || []).map((s) => {
      const down = incident?.service === s.name;
      return { name: s.name, vmid: s.vmid || null, ok: !down, detail: down ? 'systemd: activating (auto-restart)' : 'systemd: active', failAs: s.failAs || null };
    }),
    guest_docker: GUEST_DOCKER.map((c) => {
      const down = incident?.container === c.name;
      return { vmid: c.vmid, name: c.name, state: down ? 'restarting' : 'running', status: down ? 'Restarting (1) 4 seconds ago' : 'Up 9 days', health: down ? null : 'healthy' };
    }),
    backups: {
      jobs: [{ id: 'nightly', enabled: true, schedule: '03:00', storage: 'tank-backups', vmids: [100, 102, 103, 104, 105, 106, 107], all: false, mode: 'snapshot', keep: { 'keep-last': '7' },
        next_run: sec(nextAt(3, 0)), comment: 'Every guest except the Windows VM',
        latest: Object.fromEntries([100, 102, 103, 104, 105, 106, 107].map((v, i) => [v, { ctime: sec(nextAt(3, 0) - DAY + (i + 1) * 2 * MIN), size: 2e9 }])) }],
      tasks: [{ start: sec(nextAt(3, 0) - DAY), end: sec(nextAt(3, 0) - DAY + 16 * MIN), status: 'OK', id: '' }],
    },
    versions: VERSIONS.pve,
  };
}

function macReport(m) {
  const c = m.reporterConfig || {};
  const studio = m.id === 'studio';
  const cpu = wave(`${m.id}-cpu`, studio ? 11 : 6, studio ? 8 : 4);
  const memGB = studio ? 64 : 16;
  const out = {
    ok: true, mode: 'fast', collected_at: sec(now()),
    stats: {
      os: { name: 'macOS', version: '26.1', build: '25B78' }, hostname: `${m.host}.local`, model: studio ? 'Mac14,13' : 'Mac16,10',
      cpu_name: studio ? 'Apple M2 Max' : 'Apple M4', cores: studio ? 12 : 10, uptime_s: sec(now() - BOOT + (studio ? 3 : 9) * DAY),
      load: [cpu / 10, cpu / 11, cpu / 12].map((x) => Math.round(x * 100) / 100), cpu_percent: cpu,
      mem: { total_bytes: memGB * GB, used_bytes: Math.round(memGB * (studio ? 0.58 : 0.47) * GB + wave(`${m.id}-mem`, 0, 0.6) * GB), pressure_free_percent: studio ? 61 : 72 },
      swap: { total_bytes: 2 * GB, used_bytes: 0.1 * GB },
      disks: [{ mount: '/', total_bytes: (studio ? 2 : 0.5) * TB, used_bytes: (studio ? 0.86 : 0.21) * TB }],
      top: studio
        ? [{ pid: 811, cpu: wave('ol', 9, 6), rss_bytes: 9.6 * GB, name: 'ollama' }, { pid: 642, cpu: 2.1, rss_bytes: 1.4 * GB, name: 'com.docker.backend' }, { pid: 402, cpu: 1.2, rss_bytes: 0.3 * GB, name: 'WindowServer' }, { pid: 1203, cpu: 0.6, rss_bytes: 0.1 * GB, name: 'node' }]
        : [{ pid: 512, cpu: 1.8, rss_bytes: 0.4 * GB, name: 'homebridge' }, { pid: 530, cpu: 1.1, rss_bytes: 0.2 * GB, name: 'syncthing' }],
    },
    launchd: (c.launchd || []).map((j) => {
      const down = incident?.launchd === j.label;
      return { label: j.label, ok: !down, detail: down ? 'not running (last exit 1)' : j.periodic ? 'last exit 0' : `running (pid ${1000 + (j.label.length * 37) % 900})` };
    }),
    ports: (c.ports || []).map((p) => ({ name: p.name, ok: true, detail: p.kind === 'tcp' ? 'port open' : 'HTTP 200', ms: jitter(4, 3) })),
    files: (c.files || []).map((f) => ({ name: f.name, ok: true, age_min: Math.round((now() - nextAt(2, 0) + DAY) / MIN), detail: `ok (updated ${Math.round((now() - nextAt(2, 0) + DAY) / HOUR)} h ago)` })),
    procs: [],
    versions: VERSIONS[m.id] || {},
    sudo_power: studio,
  };
  if (c.docker) out.docker = { containers: [
    { name: 'open-webui', state: 'running', status: 'Up 6 days (healthy)', health: 'healthy', image: 'ghcr.io/open-webui/open-webui:0.6.40', project: 'openwebui' },
    { name: 'searxng', state: 'running', status: 'Up 6 days', health: null, image: 'searxng/searxng', project: 'openwebui' },
    { name: 'cliproxyapi', state: 'running', status: 'Up 6 days', health: null, image: 'eceasy/cli-proxy-api', project: 'hub' },
  ] };
  if (c.hub_quota) out.hub_quota = quota();
  if (studio) out.standby_role = { active: false, events: (ctx.store.demoRoleEvents || []) };
  return out;
}

function linuxReport(m) {
  const c = m.reporterConfig || {};
  const cpu = wave('pi-cpu', 4, 3);
  return {
    ok: true, mode: 'fast', collected_at: new Date().toISOString(),
    stats: { hostname: m.host, os: { name: 'Debian GNU/Linux', version: '13', kernel: '6.12.47+rpt-rpi-2712' }, cpu_name: 'Cortex-A76', cores: 4,
      load: [cpu / 25, cpu / 28, cpu / 30].map((x) => Math.round(x * 100) / 100), uptime_s: sec(now() - BOOT + 11 * DAY), cpu_percent: cpu, iowait_percent: wave('pi-io', 0.6, 0.4),
      mem: { total_bytes: 8 * GB, used_bytes: Math.round((1.9 + wave('pi-mem', 0, 0.1)) * GB) }, swap: { total_bytes: 0.5 * GB, used_bytes: 0 },
      disks: [{ mount: '/', total_bytes: 64 * GB, used_bytes: 9.4 * GB }, { mount: '/mnt/backup', total_bytes: 8 * TB, used_bytes: 3.1 * TB }], cpu_temp_c: wave('pi-t', 52, 3) },
    guest_services: (c.services || []).map((s) => ({ name: s.name, vmid: null, ok: true, detail: 'systemd: active', failAs: null })),
    ports: [], files: (c.files || []).map((f) => ({ name: f.name, ok: true, age_min: 2 * 24 * 60, detail: 'ok (updated 2 days ago)' })),
    versions: {}, sudo_power: true,
  };
}

function winReport() {
  return { stats: { hostname: 'GAMING-PC', os: 'Windows 11 Pro 25H2', cpu_name: 'AMD Ryzen 7 9800X3D', cores: 16, cpu_percent: wave('w', 6, 4), uptime_s: 7200,
    mem: { total_bytes: 64 * GB, used_bytes: 14 * GB }, disks: [{ mount: 'C:', total_bytes: 2 * TB, used_bytes: 0.9 * TB }],
    gpu: [{ name: 'NVIDIA GeForce RTX 4080', util_percent: wave('gpu', 4, 3), temp_c: 41 }], user: 'gamer', ollama: { running: true } } };
}

function quota() {
  const reset = (h) => sec(now() + h * HOUR);
  return { fetched_at: sec(now()), accounts: [
    { provider: 'claude', account: 'claude-max@example.com', plan: 'Max 5x', priority: 10, success: 1840, failed: 3, observed_at: sec(now()),
      windows: [{ label: '5-hour', used: wave('q1', 34, 10, 30), resets_at: reset(2.4) }, { label: 'Weekly', used: 58, resets_at: reset(61) }, { label: 'Weekly Opus', used: 41, resets_at: reset(61) }] },
    { provider: 'codex', account: 'chatgpt-plus@example.com', plan: 'Plus', success: 412, failed: 0, observed_at: sec(now()),
      windows: [{ label: '5-hour', used: wave('q2', 12, 6, 30), resets_at: reset(3.9) }, { label: 'Weekly', used: 27, resets_at: reset(110) }] },
    { provider: 'claude', account: 'claude-pro@example.com', plan: 'Pro', success: 96, failed: 1, observed_at: sec(now()),
      windows: [{ label: '5-hour', used: 91, resets_at: reset(1.1) }, { label: 'Weekly', used: 73, resets_at: reset(40) }] },
  ] };
}

// next occurrence of hh:mm local time (for "last night at 3:00" style data)
function nextAt(h, mi) {
  const d = new Date(); d.setHours(h, mi, 0, 0);
  if (d.getTime() <= now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// ---------------------------------------------------------------- history, updates, activity
function seedStore() {
  const { store } = ctx;
  // two hours of chart history
  for (const m of ctx.MACHINES) {
    if (!m.reporter || (m.optional && OFFLINE[m.ts])) continue;
    const memPct = m.reporter === 'pve' ? 60 : m.id === 'studio' ? 58 : 47;
    const base = m.reporter === 'pve' ? 14 : m.id === 'studio' ? 11 : 6;
    store.history[m.id] = Array.from({ length: 120 }, (_, i) => {
      const t = now() - (120 - i) * MIN;
      const cpu = Math.max(1, base + base * 0.6 * Math.sin(i / 9 + m.id.length) + (Math.random() * 2 - 1) * base * 0.3 + (i > 70 && i < 80 && m.reporter === 'pve' ? 30 : 0));
      return { t, cpu: Math.round(cpu * 10) / 10, mem: Math.round((memPct + 2 * Math.sin(i / 23)) * 10) / 10 };
    });
  }
  // pending updates
  const t = now() - 2 * HOUR;
  store.updates = {
    pve: { checkedAt: t, osVersion: VERSIONS.pve.pve,
      host: { items: [{ name: 'proxmox-kernel-6.17', current: '6.17.2-1', available: '6.17.2-2', security: false }, { name: 'openssl', current: '3.5.1-1', available: '3.5.4-1~deb13u1', security: true }, { name: 'pve-manager', current: '9.1.4', available: '9.1.5', security: false }], error: null },
      guests: {
        102: { items: [{ name: 'openssl', current: '3.0.13', available: '3.0.13-0ubuntu3.6', security: true }, { name: 'tzdata', current: '2025b', available: '2025c', security: false }] },
        103: { items: [{ name: 'jellyfin-server', current: '10.11.2', available: '10.11.3', security: false }, { name: 'jellyfin-web', current: '10.11.2', available: '10.11.3', security: false }] },
        105: { items: [{ name: 'docker-ce', current: '28.5.1', available: '28.5.2', security: false }] },
      } },
    studio: { checkedAt: t, osVersion: '26.1', brew: { items: [{ name: 'git', current: '2.51.0', available: '2.51.1' }, { name: 'node', current: '24.10.0', available: '24.11.0' }, { name: 'restic', current: '0.18.0', available: '0.18.1' }, { name: 'ollama', current: '0.13.0', available: '0.13.1' }] }, macos: { items: [] } },
    pi: { checkedAt: t, osVersion: '13', host: { items: [{ name: 'raspi-firmware', current: '1:1.20250915', available: '1:1.20251104', security: false }] } },
    mini: { checkedAt: t, osVersion: '26.1', brew: { items: [] }, macos: { items: [{ name: 'macOS Tahoe 26.1.1', available: '26.1.1', restart: true }] } },
    gaming: { checkedAt: t - 5 * HOUR, winget: [{ name: 'Steam', current: '2.10.91.91', available: '2.10.91.94' }, { name: 'Discord', current: '1.0.9214', available: '1.0.9218' }], windows_update: [], pending_reboot: false },
  };
  for (const u of Object.keys(LATEST)) store.upstream[u] = { latest: LATEST[u], checkedAt: t, error: null };
  // a day and a half of activity (failovers come from the backup's history: demoRoleEvents)
  const ev = (ago, kind, status, title, detail, machine, extra = {}) => ({ id: Math.random().toString(16).slice(2, 10), at: now() - ago, kind, status, title, detail, machine, ...extra });
  store.events = [
    ev(34 * HOUR, 'job', 'running', 'Started: Upgrade Pi-hole (CT 102) packages (6)', null, 'Proxmox Host', { who: 'you@github' }),
    ev(34 * HOUR - 2 * MIN, 'job', 'ok', 'Finished: Upgrade Pi-hole (CT 102) packages (6)', 'exit 0 · 94 s', 'Proxmox Host', { who: 'you@github' }),
    ev(27 * HOUR, 'problem', 'down', 'TrueNAS web UI is down', 'timeout after 6s · during the nightly router restart', 'Proxmox Host'),
    ev(27 * HOUR - 9 * MIN, 'recovered', 'ok', 'TrueNAS web UI is OK again', 'was down for 9 min', 'Proxmox Host'),
    ev(19 * HOUR - 4 * MIN, 'alert', 'ok', 'Telegram alert sent', '🔴 Home lab: something is down · Status dashboard (primary) (Proxmox Host): systemd: failed'),
    ev(9 * HOUR, 'stopped', 'off', 'Windows 11 (VM 108) marked as stopped on purpose', 'Shown grey until it is running again', 'Proxmox Host', { who: 'you@github' }),
    ev(5 * HOUR, 'problem', 'warn', 'Disk /dev/sdc (WDC_WD80EFPX) needs attention', 'SMART: 8 reallocated sectors', 'Proxmox Host'),
    ev(4 * HOUR + 30 * MIN, 'ack', 'info', 'Hid Disk /dev/sdc until it changes', null, null, { who: 'you@github' }),
    ev(3 * HOUR, 'recovered', 'ok', 'Disk /dev/sdc (WDC_WD80EFPX) is OK again', 'replaced the disk, resilver done', 'Proxmox Host'),
    ev(70 * MIN, 'job', 'running', 'Started: Upgrade Homebrew packages (6)', null, 'Mac Mini', { who: 'you@github' }),
    ev(64 * MIN, 'job', 'ok', 'Finished: Upgrade Homebrew packages (6)', 'exit 0 · 6 min', 'Mac Mini', { who: 'you@github' }),
  ].sort((a, b) => a.at - b.at);
  store.demoRoleEvents = [
    { at: now() - 19 * HOUR, active: true, message: 'Primary unreachable (no answer from the primary). Backup on Mac Studio took over.' },
    { at: now() - 19 * HOUR + 11 * MIN, active: false, message: 'Primary is healthy again. Backup handed status back.' },
  ];
  store.eventsBackfilled = true; store.eventsDurationsFixed = true;
  ctx.save();
}
