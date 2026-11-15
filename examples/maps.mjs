// Example maps for the fictional lab in examples/config.mjs. Copy to ../maps.mjs
// (git ignores it) and redraw for your own setup; docs/MAPS.md explains the format.
// Every node can bind to live status, so the maps light up with the same checks
// as the dashboard.
//
// Node:  { id, label, sub, icon, x, y, w?, ts?, badges?, faded?, risk?, info: [[k, v]], open?, bind }
//   x/y = center in map units. bind = how its live status is found (any of):
//   { machine: id } | { probe: id } | { check: [machineId, checkName] } | { checkGroup: [machineId, group] }
//   | { guest: vmid } | { ts: tailscaleName } | { quota: provider }      An array = the worst of them.
// Edge:  { from, to, type, label?, both?, hard?, via? }   (both = two-way; hard: false = soft dependency)
// Zone:  { label, sub?, x, y, w, h, inner? }              (x/y = top-left)

// ============================================================ 1. network
const network = {
  id: 'network',
  title: 'Network',
  blurb: 'Every device, where it is and how it is connected: LAN, Tailscale, the subnet route, the exit node and DNS.',
  w: 1500, h: 960,
  risers: [12, 1032, 1488], // free vertical lanes for tailnet links that would cross a box
  router: 'smart',           // curves when clear, right-angle detours around boxes otherwise
  edgeTypes: {
    lan:     { label: 'LAN', slot: 3, dash: '' },
    tailnet: { label: 'Tailscale', slot: 1, dash: '6 5', flow: true },
    route:   { label: 'Subnet route / exit node', slot: 7, dash: '2 4', flow: true },
    egress:  { label: 'Exit node traffic', slot: 2, dash: '10 4 2 4', flow: true },
    dns:     { label: 'DNS', slot: 5, dash: '1 4' },
    wan:     { label: 'Internet uplink', slot: 0, dash: '' },
    monitor: { label: 'Dashboard failover', slot: 0, dash: '3 3', optional: true },
  },
  zones: [
    { id: 'z-net', label: 'Internet', x: 20, y: 20, w: 1460, h: 118 },
    { id: 'z-home', label: 'Home', sub: '192.168.1.0/24', x: 20, y: 236, w: 1000, h: 704 },
    { id: 'z-pve', label: 'pve · Proxmox VE 9', sub: 'Mini PC · Ryzen 7 · 64 GB', x: 40, y: 340, w: 560, h: 420, inner: true },
    { id: 'z-studio', label: 'mac-studio · macOS', sub: 'M2 Max · 64 GB · Docker', x: 630, y: 340, w: 370, h: 330, inner: true },
    { id: 'z-go', label: 'On the go', sub: 'Tailscale everywhere', x: 1045, y: 236, w: 435, h: 168 },
    { id: 'z-cloud', label: 'Cloud', sub: 'small VPS, public IP', x: 1045, y: 428, w: 435, h: 168 },
    { id: 'z-parents', label: 'Parents\' house', sub: 'offsite backups', x: 1045, y: 620, w: 435, h: 168 },
  ],
  bus: { id: 'tailnet', label: 'Tailscale tailnet · example-tailnet.ts.net', sub: 'every device reaches every other by name or 100.x', y: 186, x1: 20, x2: 1480 },
  nodes: [
    { id: 'internet', label: 'Internet', sub: 'fiber · 1 Gbit', icon: 'globe', x: 220, y: 82, w: 250, info: [['ISP', 'Any; nothing here needs a public port']] },
    { id: 'tsctl', label: 'Tailscale control + DERP', sub: 'coordination, relays', icon: 'cloud', x: 620, y: 82, w: 260, info: [['Note', 'If this is unreachable the dashboard holds alerts: it is your internet, not your services']] },
    { id: 'pubdns', label: 'Upstream DNS', sub: 'Quad9 · Cloudflare', icon: 'globe', x: 1020, y: 82, w: 240, info: [['Used by', 'Pi-hole']] },
    { id: 'b2', label: 'Backblaze B2', sub: 'offsite, encrypted', icon: 'cloud', x: 1340, y: 82, w: 220, info: [['Gets', 'TrueNAS cloud sync, nightly']] },

    { id: 'router', label: 'Home router', sub: '192.168.1.1', icon: 'router', x: 520, y: 290, info: [['DHCP', 'Hands out Pi-hole (192.168.1.53) as DNS']] },

    { id: 'pve', label: 'pve', sub: '192.168.1.10', icon: 'server', x: 320, y: 420, w: 220, badges: ['subnet router'], bind: { machine: 'pve' }, open: '/#pve', info: [['What', 'Proxmox VE 9 on a mini PC'], ['Tailscale', 'On the host: routes 192.168.1.0/24 to the tailnet']] },
    { id: 'ct102', label: 'Pi-hole', sub: 'CT 102 · 192.168.1.53', icon: 'shield', x: 140, y: 486, bind: [{ guest: 102 }, { probe: 'pihole-dns' }], open: '/#pve', info: [['Role', 'DNS + ad blocking for every device at home']] },
    { id: 'ct103', label: 'jellyfin', sub: 'CT 103 · media', icon: 'film', x: 320, y: 486, bind: [{ guest: 103 }, { probe: 'jellyfin' }], open: '/#pve' },
    { id: 'ct104', label: 'Vaultwarden', sub: 'CT 104 · passwords', icon: 'lock', x: 500, y: 486, bind: [{ guest: 104 }, { probe: 'vaultwarden' }], open: '/#pve' },
    { id: 'ct105', label: 'immich', sub: 'CT 105 · photos', icon: 'image', x: 140, y: 568, bind: [{ guest: 105 }, { probe: 'immich' }], open: '/#pve' },
    { id: 'ct106', label: 'status-primary', sub: 'CT 106 · this dashboard', icon: 'box', x: 320, y: 568, bind: { guest: 106 }, open: '/#pve' },
    { id: 'ct107', label: 'Paperless', sub: 'CT 107 · documents', icon: 'note', x: 500, y: 568, bind: [{ guest: 107 }, { probe: 'paperless' }], open: '/#pve' },
    { id: 'vm100', label: 'Home Assistant', sub: 'VM 100', icon: 'home', x: 140, y: 650, bind: [{ guest: 100 }, { probe: 'ha' }], open: '/#pve' },
    { id: 'vm101', label: 'TrueNAS', sub: 'VM 101 · 192.168.1.20', icon: 'disk', x: 320, y: 650, bind: [{ guest: 101 }, { probe: 'truenas-ui' }], open: '/#pve', info: [['Pool', 'tank: 4 × 8 TB RAIDZ1']] },
    { id: 'vm108', label: 'Windows 11', sub: 'VM 108 · off', icon: 'vm', x: 500, y: 650, faded: true, bind: { guest: 108 }, info: [['State', 'Stopped, not started at boot']] },
    { id: 'storage', label: 'Disks', sub: 'NVMe (guests) · tank (HBA passthrough)', icon: 'disk', x: 320, y: 722, w: 330, bind: { checkGroup: ['pve', 'Resources'] }, open: '/#pve' },

    { id: 'studio', label: 'mac-studio', sub: '192.168.1.12', icon: 'desktop', x: 815, y: 420, w: 220, bind: { machine: 'studio' }, open: '/#studio', info: [['Runs', 'Ollama, Open WebUI, the dashboard backup']] },
    { id: 'owui', label: 'Open WebUI', sub: 'Docker · :3000', icon: 'chat', x: 720, y: 486, w: 160, bind: [{ probe: 'owui' }, { check: ['studio', 'Open WebUI :3000'] }], open: '/#studio' },
    { id: 'ollama', label: 'Ollama', sub: ':11434', icon: 'chip', x: 910, y: 486, w: 160, bind: [{ probe: 'ollama' }, { check: ['studio', 'Ollama'] }], open: '/#studio' },
    { id: 'statusbk', label: 'status-backup', sub: 'dashboard standby', icon: 'box', x: 720, y: 568, w: 160, bind: { check: ['studio', 'Status dashboard (backup)'] }, open: '/#studio', info: [['Role', 'Takes over svc:status only while the primary is down']] },
    { id: 'restic', label: 'Nightly backup', sub: 'restic → TrueNAS', icon: 'archive', x: 910, y: 568, w: 160, bind: [{ check: ['studio', 'Nightly backup'] }, { check: ['studio', 'Last nightly backup'] }], open: '/#studio' },

    { id: 'mini', label: 'mac-mini', sub: '192.168.1.13', icon: 'desktop', x: 815, y: 740, w: 220, bind: { machine: 'mini' }, open: '/#mini', info: [['Runs', 'Homebridge, Syncthing']] },
    { id: 'gaming', label: 'gaming-pc', sub: 'Windows · RTX 4080', icon: 'desktop', x: 320, y: 870, w: 220, bind: { machine: 'gaming' }, open: '/#gaming', info: [['Note', 'Often off: shown grey, not red']] },
    { id: 'homedev', label: 'Everything else', sub: 'phones, TVs, smart plugs', icon: 'network', x: 815, y: 870, w: 220, info: [['DNS', 'Pi-hole, via the router\'s DHCP']] },

    { id: 'laptop', label: 'MacBook Air', sub: 'laptop', icon: 'laptop', x: 1150, y: 318, w: 170, bind: { machine: 'laptop' }, open: '/#laptop' },
    { id: 'phone', label: 'Phone', sub: 'Tailscale on demand', icon: 'phone', x: 1365, y: 318, w: 170, bind: { ts: 'phone' } },
    { id: 'vps', label: 'vps', sub: 'public IP · Caddy', icon: 'server', x: 1150, y: 510, w: 170, badges: ['exit node'], bind: [{ machine: 'vps' }, { probe: 'ts-exit' }], open: '/#vps' },
    { id: 'caddy', label: 'photos.example.com', sub: 'reverse proxy', icon: 'globe', x: 1365, y: 510, w: 190, bind: { probe: 'caddy' }, info: [['Serves', 'Immich share links to friends, over the tailnet to CT 105']] },
    { id: 'pi', label: 'Raspberry Pi', sub: 'USB disk · backup target', icon: 'server', x: 1150, y: 702, w: 170, bind: { machine: 'pi' }, open: '/#pi', info: [['Gets', 'TrueNAS replication of the important datasets, weekly']] },
    { id: 'parentslan', label: 'Their LAN', sub: 'not routed', icon: 'network', x: 1365, y: 702, w: 170 },
  ],
  edges: [
    { from: 'router', to: 'internet', type: 'wan', label: 'uplink' },
    { from: 'tailnet', to: 'tsctl', type: 'tailnet', label: 'control plane' },
    { from: 'router', to: 'pve', type: 'lan', label: 'LAN (vmbr0)' },
    { from: 'router', to: 'studio', type: 'lan' },
    { from: 'router', to: 'mini', type: 'lan' },
    { from: 'router', to: 'gaming', type: 'lan' },
    { from: 'router', to: 'homedev', type: 'lan', label: 'Wi-Fi / Ethernet' },
    { from: 'router', to: 'ct102', type: 'dns', label: 'DHCP hands out Pi-hole as DNS' },
    { from: 'ct102', to: 'pubdns', type: 'dns', label: 'upstream DNS', via: [[615, 486], [615, 156], [1020, 156]] },
    { from: 'pve', to: 'tailnet', type: 'route', label: 'routes 192.168.1.0/24' },
    { from: 'studio', to: 'tailnet', type: 'tailnet' },
    { from: 'mini', to: 'tailnet', type: 'tailnet' },
    { from: 'gaming', to: 'tailnet', type: 'tailnet' },
    { from: 'laptop', to: 'tailnet', type: 'tailnet' },
    { from: 'phone', to: 'tailnet', type: 'tailnet' },
    { from: 'vps', to: 'tailnet', type: 'route', label: 'exit node' },
    { from: 'pi', to: 'tailnet', type: 'tailnet' },
    { from: 'pi', to: 'parentslan', type: 'lan' },
    { from: 'laptop', to: 'vps', type: 'egress', label: 'exit node on public Wi-Fi' },
    { from: 'vps', to: 'caddy', type: 'egress', label: 'public HTTPS' },
    { from: 'ct106', to: 'statusbk', type: 'monitor', label: 'health :3901 every 20 s, failover', both: true },
  ],
};

// ============================================================ 2. services
// Lanes = the host a service lives on (rows); columns = its role.
const COL = { entry: 160, front: 420, app: 680, data: 940, back: 1200 };
const LANE = {
  you:    { label: 'You', y: 50, h: 100 },
  pve:    { label: 'pve (Proxmox)', y: 166, h: 292 },
  studio: { label: 'mac-studio', y: 474, h: 164 },
  mini:   { label: 'mac-mini', y: 654, h: 100 },
  gaming: { label: 'gaming-pc', y: 770, h: 100 },
  ext:    { label: 'Outside', y: 886, h: 164 },
};
const at = (lane, col, row = 0) => ({ x: COL[col], y: LANE[lane].y + 50 + row * 64 });
const svc = (id, label, sub, icon, lane, col, row, extra = {}) => ({ id, label, sub, icon, lane, ...at(lane, col, row), w: 204, ...extra });

const services = {
  id: 'services',
  title: 'Services',
  blurb: 'Which service lives where and what it talks to. Turn on Impact and pick a service to see everything that stops working without it.',
  w: 1360, h: 1066,
  impact: true,
  router: 'ortho',
  fit: 'width',
  columns: [['entry', 'Clients'], ['front', 'Front doors'], ['app', 'Apps'], ['data', 'Storage & backup'], ['back', 'AI backends']].map(([k, label]) => ({ x: COL[k], label })),
  lanes: Object.entries(LANE).map(([id, l]) => ({ id, ...l })),
  edgeTypes: {
    link:    { label: 'Uses / opens', slot: 0, dash: '' },
    model:   { label: 'AI model calls', slot: 1, dash: '', flow: true },
    data:    { label: 'Files & backups', slot: 7, dash: '2 4', flow: true },
    web:     { label: 'Web / DNS', slot: 2, dash: '10 4 2 4', flow: true },
    message: { label: 'Alerts', slot: 5, dash: '1 4' },
  },
  nodes: [
    svc('browser', 'Browser', 'laptop · phone', 'globe', 'you', 'front', 0),
    svc('apps', 'Phone apps', 'Home Assistant · Immich · Bitwarden', 'phone', 'you', 'entry', 0),

    svc('pihole', 'Pi-hole', 'DNS + ad blocking', 'shield', 'pve', 'front', 0, { bind: [{ guest: 102 }, { probe: 'pihole-dns' }], open: '/#pve' }),
    svc('status', 'Status dashboard', 'status.example-tailnet.ts.net', 'pulse', 'pve', 'front', 1, { bind: { guest: 106 }, open: '/', info: [['Lives in', 'CT 106 (primary), mac-studio (backup)']] }),
    svc('vault', 'Vaultwarden', 'passwords · CT 104', 'lock', 'pve', 'front', 2, { bind: [{ probe: 'vaultwarden' }, { guest: 104 }], open: '/#pve' }),
    svc('ha', 'Home Assistant', 'VM 100', 'home', 'pve', 'app', 0, { bind: [{ probe: 'ha' }, { guest: 100 }], open: '/#pve', badges: ['core'] }),
    svc('jellyfin', 'Jellyfin', 'media · CT 103', 'film', 'pve', 'app', 1, { bind: [{ probe: 'jellyfin' }, { guest: 103 }], open: '/#pve' }),
    svc('immich', 'Immich', 'photos · CT 105', 'image', 'pve', 'app', 2, { bind: [{ probe: 'immich' }, { guest: 105 }], open: '/#pve' }),
    svc('paperless', 'Paperless-ngx', 'documents · CT 107', 'note', 'pve', 'app', 3, { bind: [{ probe: 'paperless' }, { guest: 107 }], open: '/#pve' }),
    svc('truenas', 'TrueNAS', 'VM 101 · tank', 'disk', 'pve', 'data', 0, { bind: [{ guest: 101 }, { probe: 'truenas-ui' }], open: '/#pve', badges: ['core'], info: [['Shares', 'media (NFS), photos (NFS), documents (SMB), backups']] }),
    svc('vzdump', 'Proxmox backups', 'nightly vzdump', 'archive', 'pve', 'data', 1, { bind: { check: ['pve', 'Backup job nightly'] }, open: '/#pve' }),

    svc('owui', 'Open WebUI', 'chat.example-tailnet.ts.net', 'chat', 'studio', 'front', 0, { bind: [{ probe: 'owui' }, { check: ['studio', 'open-webui'] }], open: '/#studio' }),
    svc('statusbk', 'Status (backup)', 'standby copy', 'pulse', 'studio', 'front', 1, { bind: { check: ['studio', 'Status dashboard (backup)'] }, open: '/#studio' }),
    svc('restic', 'restic', 'nightly · 02:00', 'archive', 'studio', 'data', 0, { bind: [{ check: ['studio', 'Nightly backup'] }, { check: ['studio', 'Last nightly backup'] }], open: '/#studio' }),
    svc('ollama', 'Ollama', 'Apple GPU · :11434', 'chip', 'studio', 'back', 0, { bind: [{ probe: 'ollama' }, { check: ['studio', 'Ollama'] }], open: '/#studio' }),
    svc('hub', 'CLIProxyAPI hub', 'AI subscriptions', 'hub', 'studio', 'back', 1, { info: [['Does', 'Pools Claude and ChatGPT subscriptions behind one OpenAI-style API']] }),

    svc('homebridge', 'Homebridge', 'HomeKit bridge', 'home', 'mini', 'app', 0, { bind: [{ probe: 'homebridge' }, { check: ['mini', 'Homebridge'] }], open: '/#mini' }),
    svc('syncthing', 'Syncthing', 'phone photo folders', 'sync', 'mini', 'data', 0, { bind: { check: ['mini', 'Syncthing'] }, open: '/#mini' }),
    svc('ollamagpu', 'Ollama (GPU)', 'RTX 4080 · when on', 'chip', 'gaming', 'back', 0, { bind: { probe: 'ollama-gpu' }, open: '/#gaming' }),

    svc('caddy', 'Caddy on the VPS', 'photos.example.com', 'globe', 'ext', 'entry', 0, { bind: { probe: 'caddy' }, open: '/#vps' }),
    svc('friends', 'Friends & family', 'shared albums', 'globe', 'ext', 'entry', 1),
    svc('pubdns', 'Upstream DNS', 'Quad9 · Cloudflare', 'globe', 'ext', 'front', 0),
    svc('telegram', 'Telegram', 'alert bot', 'chat', 'ext', 'front', 1),
    svc('devices', 'Smart-home devices', 'Zigbee · Wi-Fi', 'bolt', 'ext', 'app', 0),
    svc('b2', 'Backblaze B2', 'offsite · encrypted', 'cloud', 'ext', 'data', 0),
    svc('claude', 'Claude', 'subscription', 'spark', 'ext', 'back', 0, { bind: { quota: 'claude' } }),
    svc('openai', 'ChatGPT / Codex', 'subscription', 'spark', 'ext', 'back', 1, { bind: { quota: 'codex' } }),
  ],
  edges: [
    { from: 'browser', to: 'owui', type: 'link', hard: false },
    { from: 'browser', to: 'status', type: 'link', hard: false },
    { from: 'browser', to: 'vault', type: 'link', hard: false },
    { from: 'browser', to: 'ha', type: 'link', hard: false },
    { from: 'apps', to: 'ha', type: 'link' },
    { from: 'apps', to: 'immich', type: 'link' },
    { from: 'apps', to: 'vault', type: 'link' },
    { from: 'friends', to: 'caddy', type: 'web' },
    { from: 'caddy', to: 'immich', type: 'web', label: 'share links, over the tailnet' },

    { from: 'ha', to: 'devices', type: 'link', label: 'Zigbee + Wi-Fi' },
    { from: 'homebridge', to: 'ha', type: 'link', label: 'HomeKit bridge' },
    { from: 'jellyfin', to: 'truenas', type: 'data', label: 'media (NFS)' },
    { from: 'immich', to: 'truenas', type: 'data', label: 'library (NFS)' },
    { from: 'paperless', to: 'truenas', type: 'data', label: 'documents' },
    { from: 'syncthing', to: 'truenas', type: 'data', label: 'phone photos' },
    { from: 'restic', to: 'truenas', type: 'data', label: 'restic repo' },
    { from: 'vzdump', to: 'truenas', type: 'data', label: 'guest backups' },
    { from: 'truenas', to: 'b2', type: 'data', label: 'cloud sync, nightly' },

    { from: 'owui', to: 'ollama', type: 'model' },
    { from: 'owui', to: 'ollamagpu', type: 'model', label: 'when the PC is on', hard: false },
    { from: 'owui', to: 'hub', type: 'model', hard: false },
    { from: 'hub', to: 'claude', type: 'model' },
    { from: 'hub', to: 'openai', type: 'model' },

    { from: 'pihole', to: 'pubdns', type: 'web', label: 'upstream' },
    { from: 'status', to: 'telegram', type: 'message', label: 'critical alerts' },
    { from: 'statusbk', to: 'status', type: 'link', label: 'failover watch', both: true },
  ],
};

// ============================================================ 3. data & backups
const data = {
  id: 'data',
  title: 'Data & backups',
  blurb: 'Where your data lives, which job copies it, and where the copies end up. Amber notes are gaps worth fixing.',
  w: 1340, h: 760,
  columns: [{ x: 230, label: 'Data' }, { x: 690, label: 'Copied by' }, { x: 1150, label: 'Lands in' }],
  edgeTypes: {
    backup: { label: 'Backup copy', slot: 7, dash: '', flow: true },
    sync:   { label: 'Sync / replication', slot: 1, dash: '6 5', flow: true },
    stored: { label: 'Stored on', slot: 3, dash: '2 4' },
    key:    { label: 'Needed to restore', slot: 5, dash: '1 4' },
  },
  nodes: [
    { id: 'photos', label: 'Photos', sub: 'Immich library · 1.2 TB', icon: 'image', x: 230, y: 90, w: 300, bind: { probe: 'immich' } },
    { id: 'docs', label: 'Documents', sub: 'Paperless archive', icon: 'note', x: 230, y: 170, w: 300, bind: { probe: 'paperless' } },
    { id: 'guests', label: 'Guest containers + VMs', sub: 'CT 102–107 · VM 100', icon: 'box', x: 230, y: 270, w: 300, bind: { guest: 106 }, open: '/#pve' },
    { id: 'macdata', label: 'Mac Studio', sub: 'Open WebUI chats · configs', icon: 'desktop', x: 230, y: 370, w: 300, bind: { machine: 'studio' }, open: '/#studio' },
    { id: 'phones', label: 'Phone camera rolls', sub: 'via Syncthing', icon: 'phone', x: 230, y: 470, w: 300 },
    { id: 'media', label: 'Media library', sub: 'Jellyfin · 9 TB', icon: 'film', x: 230, y: 580, w: 300, risk: 'Only on TrueNAS: too big for the cloud plan. It can be ripped again, so this is a known, accepted gap.' },
    { id: 'win', label: 'Windows 11 VM', sub: 'VM 108', icon: 'vm', x: 230, y: 680, w: 300, faded: true, risk: 'Not in any backup job. Fine while it holds nothing that can\'t be rebuilt.' },

    { id: 'snap', label: 'ZFS snapshots', sub: 'hourly · kept 2 weeks', icon: 'archive', x: 690, y: 130, w: 280, bind: { probe: 'truenas-ui' } },
    { id: 'vzdump', label: 'nightly (vzdump)', sub: '03:00 · keep 7 · snapshot mode', icon: 'archive', x: 690, y: 270, w: 280, bind: { check: ['pve', 'Backup job nightly'] }, open: '/#pve' },
    { id: 'restic', label: 'restic', sub: '02:00 daily · check on Sundays', icon: 'archive', x: 690, y: 370, w: 280, bind: [{ check: ['studio', 'Nightly backup'] }, { check: ['studio', 'Last nightly backup'] }], open: '/#studio' },
    { id: 'syncthing', label: 'Syncthing', sub: 'continuous', icon: 'sync', x: 690, y: 470, w: 280, bind: { check: ['mini', 'Syncthing'] }, open: '/#mini' },
    { id: 'cloudsync', label: 'Cloud sync task', sub: 'TrueNAS → B2 · nightly', icon: 'cloud', x: 690, y: 560, w: 280 },
    { id: 'repl', label: 'Replication', sub: 'TrueNAS → Pi · weekly', icon: 'sync', x: 690, y: 650, w: 280, bind: { check: ['pi', 'Last replication'] }, open: '/#pi' },

    { id: 'tank', label: 'TrueNAS · tank', sub: '4 × 8 TB RAIDZ1', icon: 'disk', x: 1150, y: 200, w: 300, bind: [{ guest: 101 }, { probe: 'truenas-ui' }], open: '/#pve' },
    { id: 'key', label: 'Encryption keys', sub: 'in Vaultwarden + printed copy', icon: 'key', x: 1150, y: 330, w: 300, info: [['Why', 'B2 and restic are encrypted: without the keys the copies are useless']] },
    { id: 'b2', label: 'Backblaze B2', sub: 'offsite #1 · encrypted', icon: 'cloud', x: 1150, y: 560, w: 300 },
    { id: 'pi', label: 'Raspberry Pi + USB disk', sub: 'offsite #2 · parents\' house', icon: 'server', x: 1150, y: 650, w: 300, bind: { machine: 'pi' }, open: '/#pi' },
  ],
  edges: [
    { from: 'photos', to: 'snap', type: 'backup' },
    { from: 'docs', to: 'snap', type: 'backup' },
    { from: 'snap', to: 'tank', type: 'stored', label: 'on the pool' },
    { from: 'guests', to: 'vzdump', type: 'backup' },
    { from: 'vzdump', to: 'tank', type: 'backup', label: 'NFS share "backups"' },
    { from: 'macdata', to: 'restic', type: 'backup' },
    { from: 'restic', to: 'tank', type: 'backup', label: 'restic repo' },
    { from: 'phones', to: 'syncthing', type: 'sync' },
    { from: 'syncthing', to: 'tank', type: 'sync', label: 'into the photos share' },
    { from: 'media', to: 'tank', type: 'stored' },
    { from: 'tank', to: 'cloudsync', type: 'backup' },
    { from: 'cloudsync', to: 'b2', type: 'backup', label: 'nightly' },
    { from: 'tank', to: 'repl', type: 'sync' },
    { from: 'repl', to: 'pi', type: 'sync', label: 'over the tailnet' },
    { from: 'key', to: 'b2', type: 'key', label: 'decrypts' },
    { from: 'key', to: 'restic', type: 'key' },
  ],
};

export const MAPS = [network, services, data];
