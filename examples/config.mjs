// Example inventory: a fictional home lab. `node server.mjs --demo` runs it with
// simulated data. For your own setup, copy this file to ../config.mjs (which git
// ignores) and describe your machines: the AI setup guide (docs/SETUP.md) does
// that for you by looking at your network. Field reference: docs/CONFIG.md.
//
// Settings that differ per copy (which host this copy runs on, how it reaches
// each machine) live in instance.json, not here: see examples/instance.*.json.

export const TAILNET = 'example-tailnet.ts.net';

// Tailscale logins allowed to run updates, controls and the web terminal.
// Everyone else on the tailnet gets a read-only dashboard.
export const OWNER_LOGINS = ['you@github'];

// Times shown in check details (e.g. "next Sun 3:30 AM"). Default: the server's zone.
export const TIMEZONE = 'Europe/London';

// Critical alerts: anything "Down" for `afterMin` minutes that you haven't
// hidden or marked as stopped on purpose. Telegram needs `chatId` here and a bot
// token file in instance.json (telegramTokenFile); or point instance.json
// `notify` at any script (ntfy, Pushover, Slack webhook, ...) that takes the text.
export const ALERTS = { enabled: false, afterMin: 3, chatId: '', url: `https://status.${TAILNET}` };

// AI quota running low shows on the quota cards; true also lists it under "Needs attention".
export const QUOTA_ALERTS = false;
// Optional: CLIProxyAPI accounts at this priority are shown as "preferred", and as
// "paused by quota guard" when disabled (if you run a script that does that).
export const QUOTA_GUARD_PRIORITY = 10;

// Known scheduled blips (e.g. a router that restarts every night). Inside a window:
// no alerts and no failover. Anything still down when it ends alerts as usual.
export const QUIET_WINDOWS = [
  // { label: 'weekly ISP maintenance', start: '02:00', end: '02:30', days: ['Tue'], tz: 'Europe/London' },
];

// Two copies (optional): the primary serves, the backup takes over while it is
// down. Delete this block if you run a single copy. See docs/SETUP.md, "Failover".
export const FAILOVER = { backupMachine: 'studio', primary: 'Proxmox Host (CT 106)', backup: 'Mac Studio' };

// How often to collect, in seconds:
// [someone has the page open, nobody watching, backup on standby, a /wall screen is open]
export const CADENCE = {
  probes: [30, 120, 300, 60],
  reporters: [60, 300, 600, 120],
  agent: [30, 300, 600, 120],
  ping: [60, 300, 600, 120],
};

const MAC_PATH = 'export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.orbstack/bin:/usr/bin:/bin:/usr/sbin:/sbin;';

// ---------------------------------------------------------------- machines
// reporter: what collects stats: 'pve' (Proxmox host) | 'linux' (any Linux box) | 'mac' (macOS) | 'winagent' (HTTP agent) | null (Tailscale status only)
// ts: the machine's Tailscale name, for online status and ping. optional: true = being off is normal (laptops, gaming PCs).
export const MACHINES = [
  {
    id: 'pve', name: 'Proxmox Host', host: 'pve', icon: 'server', site: 'Home', os: 'Proxmox VE', wide: true,
    role: 'Proxmox: Home Assistant, TrueNAS, Pi-hole, Jellyfin, Immich, Vaultwarden, Paperless, this dashboard; subnet router',
    reporter: 'pve', ts: 'pve', lan: '192.168.1.10', link: 'https://192.168.1.10:8006',
    reporterConfig: {
      // systemd units inside containers (vmid) or on the host itself (no vmid)
      guest_services: [
        { name: 'Pi-hole FTL', vmid: 102, unit: 'pihole-FTL' },
        { name: 'Jellyfin server', vmid: 103, unit: 'jellyfin' },
        { name: 'Vaultwarden', vmid: 104, unit: 'vaultwarden' },
        { name: 'Status dashboard (primary)', vmid: 106, unit: 'status-dashboard' },
        { name: 'Tailscale (host: subnet router)', unit: 'tailscaled' },
      ],
      guest_docker: [105, 107], // containers whose Docker containers are listed
      versions: [
        { name: 'pihole-ftl', vmid: 102, cmd: 'pihole-FTL --version' },
        { name: 'jellyfin', vmid: 103, cmd: "dpkg-query -W -f='${Version}' jellyfin-server | cut -d+ -f1" },
        { name: 'pve', cmd: 'pveversion | cut -d/ -f2' },
      ],
    },
  },
  {
    id: 'studio', name: 'Mac Studio', host: 'mac-studio', icon: 'desktop', site: 'Home', os: 'macOS',
    role: 'Local AI (Ollama, Open WebUI), Time Machine server, dashboard backup', reporter: 'mac', ts: 'mac-studio',
    reporterConfig: {
      standby_store: '~/homelab-status/data/store.json', // the backup copy's failover history, for the activity log
      // AI subscription quota from a CLIProxyAPI hub (optional; delete if you don't run one).
      // The management key is read on this machine and never leaves it.
      hub_quota: { base: `https://hub.${TAILNET}:8317/v0/management`, key_file: '~/.secrets/hub_mgmt_key', max_age_s: 240 },
      docker: true,
      launchd: [
        { label: 'com.ollama.ollama', name: 'Ollama' },
        { label: 'local.status.dashboard', name: 'Status dashboard (backup)' },
        { label: 'local.restic.backup', name: 'Nightly backup', periodic: true },
      ],
      ports: [
        { name: 'Ollama :11434', url: 'http://127.0.0.1:11434/api/version', expect: [200] },
        { name: 'Open WebUI :3000', url: 'http://127.0.0.1:3000/health', expect: [200] },
        { name: 'Status backup app :3900', url: 'http://127.0.0.1:3900/api/health', expect: [200] },
      ],
      files: [
        // a job writes "ok" here when it succeeds; amber if it's older than a day (+2 h)
        { name: 'Last nightly backup', path: '~/.restic/last_status', equals: 'ok', max_age_min: 1560 },
      ],
      versions: [
        { name: 'ollama', cmd: MAC_PATH + 'ollama --version | awk \'{print $NF}\'' },
        { name: 'open-webui', cmd: MAC_PATH + 'docker inspect open-webui --format "{{.Config.Image}}" | sed "s/.*://"' },
      ],
    },
  },
  {
    id: 'mini', name: 'Mac Mini', host: 'mac-mini', icon: 'desktop', site: 'Home', os: 'macOS',
    role: 'Homebridge, Syncthing, photo import', reporter: 'mac', ts: 'mac-mini',
    reporterConfig: {
      launchd: [
        { label: 'com.homebridge.server', name: 'Homebridge' },
        { label: 'homebrew.mxcl.syncthing', name: 'Syncthing' },
      ],
      ports: [
        { name: 'Homebridge UI :8581', url: 'http://127.0.0.1:8581/', expect: [200] },
        { name: 'Syncthing :8384', kind: 'tcp', port: 8384 },
      ],
    },
  },
  {
    id: 'gaming', name: 'Gaming PC', host: 'gaming-pc', icon: 'gamepad', site: 'Home', os: 'Windows',
    role: 'Games, Ollama on the GPU when it is on', reporter: 'winagent', ts: 'gaming-pc', agent: 'http://100.64.0.14:9190', optional: true,
  },
  {
    id: 'pi', name: 'Raspberry Pi', host: 'parents-pi', icon: 'server', site: 'Parents\' house', os: 'Raspberry Pi OS',
    role: 'Offsite backup target: weekly ZFS replication from TrueNAS', reporter: 'linux', ts: 'parents-pi',
    reporterConfig: {
      mounts: ['/', '/mnt/backup'],
      services: [
        { name: 'Tailscale', unit: 'tailscaled' },
        { name: 'ZFS event daemon', unit: 'zfs-zed' },
      ],
      files: [{ name: 'Last replication', path: '/mnt/backup/.last_replication', equals: 'ok', max_age_min: 8 * 24 * 60 }],
    },
  },
  { id: 'laptop', name: 'MacBook Air', host: 'macbook-air', icon: 'laptop', site: 'On the go', os: 'macOS', role: 'Daily laptop', reporter: null, ts: 'macbook-air', optional: true },
  { id: 'vps', name: 'Cloud VPS', host: 'vps', icon: 'route', site: 'Cloud', os: 'Linux', role: 'Exit node with a public IP, Caddy reverse proxy', reporter: null, ts: 'vps' },
];

// Display names for Proxmox guests (their Proxmox names are often terse).
export const GUEST_NAMES = {
  100: 'Home Assistant', 101: 'TrueNAS', 102: 'Pi-hole', 103: 'Jellyfin', 104: 'Vaultwarden',
  105: 'Immich', 106: 'Status Dashboard', 107: 'Paperless-ngx', 108: 'Windows 11',
};
// Guests not listed above: "my-new_box" -> "My New Box"
export const guestName = (vmid, raw) => GUEST_NAMES[vmid] || String(raw || `Guest ${vmid}`).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// Guests that are also Tailscale nodes: their tailnet status shows on the guest's row.
export const GUEST_TS = {
  103: { node: 'jellyfin', role: 'tailnet' },
  105: { node: 'immich', role: 'tailnet' },
  106: { node: 'status-primary', role: 'tailnet' },
};

// Docker containers that are stopped on purpose: shown grey, not red.
export const EXPECTED_STOPPED = [];

// ---------------------------------------------------------------- checks run from the dashboard host
// type: http | tcp | dns | tailscale. machine: where the service lives (grouping, and an
// optional machine being off turns its checks grey instead of red).
// expect: HTTP codes that mean "up" (default: anything below 500). 401 = up but needs a token.
// guest + {guest}: the Proxmox guest's current LAN IP (DHCP can change it); fallbackIp until known.
export const PROBES = [
  { id: 'ha', name: 'Home Assistant', group: 'Home', machine: 'pve', type: 'http', url: `https://ha.${TAILNET}/api/`, expect: [200, 401], link: `https://ha.${TAILNET}` },
  { id: 'vaultwarden', name: 'Vaultwarden', group: 'Home', machine: 'pve', type: 'http', url: `https://vault.${TAILNET}/alive`, expect: [200], link: `https://vault.${TAILNET}` },
  { id: 'paperless', name: 'Paperless-ngx', group: 'Home', machine: 'pve', type: 'http', url: `https://paperless.${TAILNET}/`, link: `https://paperless.${TAILNET}` },
  { id: 'homebridge', name: 'Homebridge', group: 'Home', machine: 'mini', type: 'http', url: 'http://100.64.0.13:8581/', link: `http://mac-mini.${TAILNET}:8581` },
  { id: 'jellyfin', name: 'Jellyfin', group: 'Media', machine: 'pve', type: 'http', url: `https://jellyfin.${TAILNET}/health`, expect: [200], link: `https://jellyfin.${TAILNET}` },
  { id: 'immich', name: 'Immich', group: 'Media', machine: 'pve', type: 'http', url: `https://immich.${TAILNET}/api/server/ping`, expect: [200], link: `https://immich.${TAILNET}` },
  { id: 'owui', name: 'Open WebUI', group: 'AI', machine: 'studio', type: 'http', url: `https://chat.${TAILNET}/health`, expect: [200], link: `https://chat.${TAILNET}` },
  { id: 'ollama', name: 'Ollama API', group: 'AI', machine: 'studio', type: 'tcp', host: '100.64.0.12', port: 11434 },
  { id: 'ollama-gpu', name: 'Ollama (GPU)', group: 'AI', machine: 'gaming', type: 'tcp', host: '100.64.0.14', port: 11434 },
  { id: 'pihole-dns', name: 'Pi-hole DNS', group: 'Network', machine: 'pve', type: 'dns', guest: 102, fallbackIp: '192.168.1.53', server: '{guest}', query: 'example.com' },
  { id: 'proxmox-ui', name: 'Proxmox web UI', group: 'Network', machine: 'pve', type: 'http', url: 'https://192.168.1.10:8006/', insecure: true, link: 'https://192.168.1.10:8006' },
  { id: 'ts-subnet', name: 'Home subnet route', group: 'Network', machine: 'pve', type: 'tailscale', node: 'pve', routes: ['192.168.1.0/24'] },
  { id: 'ts-exit', name: 'VPS exit node', group: 'Network', machine: 'vps', type: 'tailscale', node: 'vps', exitNode: true },
  { id: 'caddy', name: 'Public reverse proxy', group: 'Network', machine: 'vps', type: 'http', url: 'https://photos.example.com/', expect: [200, 401] },
  { id: 'truenas-ui', name: 'TrueNAS web UI', group: 'Storage', machine: 'pve', type: 'http', guest: 101, fallbackIp: '192.168.1.20', url: 'https://{guest}/', insecure: true, link: 'https://{guest}' },
];

// ---------------------------------------------------------------- newer versions (checked every 6 h)
// current: '<machineId>:<versions name>' from a reporter's `versions` list.
export const UPSTREAM = [
  { id: 'jellyfin', name: 'Jellyfin', machine: 'pve', current: 'pve:jellyfin', source: { github: 'jellyfin/jellyfin' } },
  { id: 'pihole-ftl', name: 'Pi-hole FTL', machine: 'pve', current: 'pve:pihole-ftl', source: { github: 'pi-hole/FTL' } },
  { id: 'open-webui', name: 'Open WebUI', machine: 'studio', current: 'studio:open-webui', source: { github: 'open-webui/open-webui' } },
  { id: 'ollama', name: 'Ollama', machine: 'studio', current: 'studio:ollama', source: { github: 'ollama/ollama' },
    hint: 'Update from the Ollama menu bar app, or `brew upgrade ollama` if it came from Homebrew.' },
];

// ---------------------------------------------------------------- update actions
// tier: 'safe' = one click; 'confirm' = type the machine name first; 'manual' = shown, no button.
// Commands are fixed strings; nothing from the browser is interpolated except
// values matched against strict patterns.
const APT = 'export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold';
const CONFIRM_GUESTS = { 106: true }; // upgrading the dashboard's own container asks first

export function actionsFor(machineId, ctx) {
  const u = ctx.updates || {};
  const kind = ctx.machine?.reporter;
  const out = [];
  if (kind === 'pve') {
    const host = u.host?.items?.length || 0;
    out.push({ id: 'apt-host', label: `Upgrade Proxmox host packages (${host})`, tier: 'confirm', enabled: host > 0,
      note: 'Runs apt dist-upgrade on the Proxmox host. Guests keep running; a new kernel takes effect after a reboot (not done automatically).',
      // `;` not `&&`: one failing repo (e.g. the enterprise repo without a subscription) must not block the upgrade
      cmd: 'export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade' });
    for (const [vmid, g] of Object.entries(u.guests || {})) {
      if (ctx.guestNames && Object.keys(ctx.guestNames).length && !ctx.guestNames[vmid]) continue; // guest no longer exists
      const n = g.items?.length || 0;
      const name = ctx.guestNames?.[vmid] || `CT ${vmid}`;
      out.push({ id: `apt-ct-${vmid}`, label: `Upgrade ${name} (CT ${vmid}) packages (${n})`, tier: CONFIRM_GUESTS[vmid] ? 'confirm' : 'safe', enabled: n > 0,
        cmd: `pct exec ${Number(vmid)} -- sh -c '${APT} upgrade'` });
    }
    const ftl = ctx.upstream?.['pihole-ftl'];
    out.push({ id: 'pihole-up', label: 'Update Pi-hole (pihole -up)', tier: 'safe', enabled: !!ftl?.outdated, cmd: 'pct exec 102 -- pihole -up' });
  }
  if (kind === 'mac') {
    const brew = u.brew?.items?.length || 0;
    out.push({ id: 'brew', label: `Upgrade Homebrew packages (${brew})`, tier: 'safe', enabled: brew > 0, cmd: `${MAC_PATH} brew upgrade` });
    const n = u.macos?.items?.length || 0;
    out.push({ id: 'macos', label: `Install macOS updates (${n})`, tier: 'manual', enabled: false,
      note: n ? 'Needs admin rights and may restart the Mac. Install from System Settings > Software Update.' : 'Up to date.' });
  }
  if (kind === 'linux') {
    const n = u.host?.items?.length || 0;
    out.push({ id: 'apt', label: `Upgrade packages (${n})`, tier: 'confirm', enabled: n > 0,
      note: 'Runs apt-get upgrade with sudo (needs rule 2 in deploy/sudoers/status-dashboard).',
      cmd: 'sudo -n /usr/bin/apt-get update; sudo -n /usr/bin/env DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade' });
  }
  if (kind === 'winagent') {
    const n = u.winget?.length || 0;
    out.push({ id: 'winget-all', label: `Upgrade apps with winget (${n})`, tier: 'safe', enabled: n > 0, agent: { what: 'winget-all' },
      note: 'Runs as the signed-in user. Apps that need admin rights fail and are listed in the log.' });
    out.push({ id: 'windows-update', label: 'Install Windows Update', tier: 'manual', enabled: false, note: 'Needs admin rights. Use Settings > Windows Update.' });
  }
  return out;
}

// ---------------------------------------------------------------- management controls
// Power and service controls, built from the live inventory (guest IDs, container
// names, launchd labels). Names are validated before they reach a command.
const SAFE_NAME = /^[A-Za-z0-9_.@-]{1,80}$/;
const CRITICAL_GUESTS = {
  102: 'Pi-hole is the DNS server for the whole home network.',
  106: 'This is the primary dashboard; the backup on the Mac Studio takes over while it is down.',
};

export function controlsFor(machineId, ctx) {
  const d = ctx.data || {};
  const kind = ctx.machine?.reporter;
  const out = [];
  if (kind === 'pve') {
    out.push({ id: 'host-reboot', group: 'Power', label: 'Reboot the Proxmox host', risky: true,
      note: 'Every VM and container goes down for a few minutes, including this dashboard (the backup takes over). Runs `shutdown -r +1`.',
      cmd: 'shutdown -r +1 "Reboot requested from the status dashboard"' });
    out.push({ id: 'host-reboot-cancel', group: 'Power', label: 'Cancel a scheduled host reboot', cmd: 'shutdown -c "Reboot cancelled from the status dashboard" && echo cancelled' });
    for (const g of d.guests || []) {
      const vmid = Number(g.vmid); if (!Number.isInteger(vmid)) continue;
      const tool = g.type === 'qemu' ? 'qm' : 'pct';
      const what = `${guestName(vmid, g.name)} (${g.type === 'qemu' ? 'VM' : 'CT'} ${vmid})`;
      const warn = CRITICAL_GUESTS[vmid] || null;
      const base = { group: 'Guests', target: String(vmid), targetName: what };
      if (g.status === 'running') {
        out.push({ ...base, id: `guest-${vmid}-reboot`, label: `Reboot ${what}`, risky: !!warn, note: warn, cmd: `${tool} reboot ${vmid}` });
        out.push({ ...base, id: `guest-${vmid}-shutdown`, label: `Shut down ${what}`, risky: true, note: warn || 'Clean shutdown (2 minute timeout).', cmd: `${tool} shutdown ${vmid} --timeout 120` });
      } else {
        out.push({ ...base, id: `guest-${vmid}-start`, label: `Start ${what}`, cmd: `${tool} start ${vmid}` });
      }
      const on = g.onboot === true;
      out.push({ ...base, id: `guest-${vmid}-onboot-${on ? 0 : 1}`, label: `${on ? 'Turn off' : 'Turn on'} start at boot for ${what}`, kind: 'toggle', on,
        note: on ? 'It stays off after the next Proxmox reboot, and the dashboard treats it as off on purpose.' : 'It starts when Proxmox boots, and the dashboard alerts when it is unexpectedly stopped.',
        cmd: `${tool} set ${vmid} --onboot ${on ? 0 : 1}` });
    }
    for (const s of ctx.machine?.reporterConfig?.guest_services || []) {
      if (!SAFE_NAME.test(s.unit)) continue;
      const where = s.vmid ? `pct exec ${Number(s.vmid)} -- ` : '';
      out.push({ id: `svc-${s.vmid || 'host'}-${s.unit}`, group: 'Services', label: `Restart ${s.name}`, target: s.vmid ? `CT ${s.vmid} · ${s.unit}` : `host · ${s.unit}`,
        risky: !!CRITICAL_GUESTS[s.vmid], note: CRITICAL_GUESTS[s.vmid] || null, cmd: `${where}systemctl restart ${s.unit}` });
    }
    for (const c of d.guest_docker || []) {
      if (!SAFE_NAME.test(c.name || '')) continue;
      out.push({ id: `ctdocker-${c.vmid}-${c.name}`, group: 'Containers', label: `${c.state === 'running' ? 'Restart' : 'Start'} ${c.name}`, target: `CT ${c.vmid} · Docker`,
        cmd: `pct exec ${Number(c.vmid)} -- docker ${c.state === 'running' ? 'restart' : 'start'} ${c.name}` });
    }
  }
  if (kind === 'mac') {
    for (const j of ctx.machine?.reporterConfig?.launchd || []) {
      if (j.periodic || !SAFE_NAME.test(j.label)) continue;
      out.push({ id: `launchd-${j.label}`, group: 'Services', label: `Restart ${j.name}`, target: j.label, cmd: `launchctl kickstart -k gui/$(id -u)/${j.label}` });
    }
    for (const c of d.docker?.containers || []) {
      if (!SAFE_NAME.test(c.name || '') || EXPECTED_STOPPED.includes(c.name)) continue;
      out.push({ id: `docker-${c.name}`, group: 'Containers', label: `${c.state === 'running' ? 'Restart' : 'Start'} ${c.name}`, target: 'Docker',
        cmd: `${MAC_PATH} docker ${c.state === 'running' ? 'restart' : 'start'} ${c.name}` });
    }
    // Power buttons need a narrow sudo rule on the Mac (see docs/SETUP.md); the reporter detects it.
    const MSG = '"Requested from the home lab status dashboard"';
    if (d.sudo_power) {
      out.push({ id: 'mac-reboot', group: 'Power', label: 'Reboot this Mac (in 1 min)', risky: true, note: 'Everything on this Mac stops for a few minutes.', cmd: `sudo -n /sbin/shutdown -r +1 ${MSG}` });
      out.push({ id: 'mac-cancel', group: 'Power', label: 'Cancel a scheduled reboot', cmd: 'if sudo -n /usr/bin/killall shutdown 2>/dev/null; then echo cancelled; else echo "nothing was scheduled"; fi' });
    } else {
      out.push({ id: 'mac-reboot', group: 'Power', label: 'Reboot this Mac', manual: true, note: 'Add the sudo rule from docs/SETUP.md to reboot from here.' });
    }
  }
  if (kind === 'linux') {
    for (const s of ctx.machine?.reporterConfig?.services || []) {
      if (!SAFE_NAME.test(s.unit)) continue;
      out.push({ id: `svc-${s.unit}`, group: 'Services', label: `Restart ${s.name}`, target: s.unit, cmd: `sudo -n /usr/bin/systemctl restart ${s.unit}` });
    }
    for (const c of d.docker?.containers || []) {
      if (!SAFE_NAME.test(c.name || '') || EXPECTED_STOPPED.includes(c.name)) continue;
      out.push({ id: `docker-${c.name}`, group: 'Containers', label: `${c.state === 'running' ? 'Restart' : 'Start'} ${c.name}`, target: 'Docker', cmd: `docker ${c.state === 'running' ? 'restart' : 'start'} ${c.name}` });
    }
    if (d.sudo_power) {
      out.push({ id: 'linux-reboot', group: 'Power', label: 'Reboot (in 1 min)', risky: true, cmd: 'sudo -n /sbin/shutdown -r +1 "Requested from the home lab status dashboard"' });
      out.push({ id: 'linux-cancel', group: 'Power', label: 'Cancel a scheduled reboot', cmd: 'sudo -n /sbin/shutdown -c && echo cancelled' });
    }
  }
  if (kind === 'winagent') {
    out.push({ id: 'pc-restart', group: 'Power', label: 'Restart the PC (in 60 s)', risky: true, agentPower: 'restart' });
    out.push({ id: 'pc-shutdown', group: 'Power', label: 'Shut down the PC (in 60 s)', risky: true, agentPower: 'shutdown', note: 'It can only be turned back on at the PC (or with Wake-on-LAN).' });
    out.push({ id: 'pc-cancel', group: 'Power', label: 'Cancel a scheduled restart or shutdown', agentPower: 'cancel' });
  }
  return out;
}

// Web terminal targets (owner only; the SSH target comes from instance.json).
export function terminalTargetsFor(machineId, ctx) {
  const d = ctx.data || {};
  const m = MACHINES.find((x) => x.id === machineId);
  if (m?.reporter === 'pve') {
    return [{ id: 'host', label: 'Proxmox host (root)', remote: null },
      ...(d.guests || []).filter((g) => g.type === 'lxc' && g.status === 'running').map((g) => ({ id: `ct-${g.vmid}`, label: `${guestName(g.vmid, g.name)} (CT ${g.vmid})`, remote: `pct enter ${Number(g.vmid)}` }))];
  }
  if (m?.reporter === 'mac' || m?.reporter === 'linux') return [{ id: 'shell', label: 'Shell', remote: null }];
  return [];
}

// ---------------------------------------------------------------- "Sites" page: a launcher with live status
// check: a probe id (reuse its status), { url, expect, insecure } for its own check, or null (just a link)
export const SITES = [
  { group: 'Home', name: 'Home Assistant', url: `https://ha.${TAILNET}`, note: 'Lights, sensors, automations (VM 100)', check: 'ha' },
  { group: 'Home', name: 'Vaultwarden', url: `https://vault.${TAILNET}`, note: 'Passwords (CT 104)', check: 'vaultwarden' },
  { group: 'Home', name: 'Paperless-ngx', url: `https://paperless.${TAILNET}`, note: 'Scanned documents, OCR (CT 107)', check: 'paperless' },
  { group: 'Home', name: 'Homebridge', url: `http://mac-mini.${TAILNET}:8581`, note: 'HomeKit bridge on the Mac Mini', check: 'homebridge' },
  { group: 'Media & AI', name: 'Jellyfin', url: `https://jellyfin.${TAILNET}`, note: 'Movies and shows (CT 103)', check: 'jellyfin' },
  { group: 'Media & AI', name: 'Immich', url: `https://immich.${TAILNET}`, note: 'Photo library (CT 105)', check: 'immich' },
  { group: 'Media & AI', name: 'Open WebUI', url: `https://chat.${TAILNET}`, note: 'Chat with local and hosted models', check: 'owui' },
  { group: 'Infrastructure', name: 'Proxmox', url: 'https://192.168.1.10:8006', note: 'Hypervisor web UI', check: 'proxmox-ui' },
  { group: 'Infrastructure', name: 'TrueNAS', guest: 101, fallbackIp: '192.168.1.20', url: 'https://{guest}', note: 'NAS (VM 101)', check: 'truenas-ui' },
  { group: 'Infrastructure', name: 'Pi-hole', guest: 102, fallbackIp: '192.168.1.53', url: 'http://{guest}/admin/', note: 'DNS and ad blocking (CT 102)', check: { url: 'http://{guest}/admin/' } },
  { group: 'Public', name: 'Shared photos', url: 'https://photos.example.com', note: 'Immich share links, through the VPS', check: 'caddy' },
];
