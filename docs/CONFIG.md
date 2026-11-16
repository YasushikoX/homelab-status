# Configuration reference

Three files next to `server.mjs` describe your lab. All three are git-ignored:

| File | What | Example |
|---|---|---|
| `config.mjs` | The inventory: machines, checks, update actions, controls, sites. The same file on every copy. | [`examples/config.mjs`](../examples/config.mjs) |
| `maps.mjs` | The three maps. Optional: without it the example maps show. | [`examples/maps.mjs`](../examples/maps.mjs), [MAPS.md](MAPS.md) |
| `instance.json` | Settings for one copy: where it runs and how it reaches each machine. | [`examples/instance.*.json`](../examples) |

`config.mjs` is a JavaScript module, so you can use template strings, helper
functions and comments. After a change: `node --check config.mjs`, then
restart the service.

## `config.mjs` exports

| Export | Type | Meaning |
|---|---|---|
| `MACHINES` | array, **required** | Every machine. See below. |
| `PROBES` | array | Checks run from the dashboard host (HTTP, TCP, DNS, Tailscale). |
| `SITES` | array | The *Sites* page: a launcher with live status. |
| `UPSTREAM` | array | Apps whose latest release is compared with the installed version. |
| `OWNER_LOGINS` | string[] | Tailscale logins allowed to run actions and the terminal (e.g. `alex@github`). Everyone else is read-only. |
| `TAILNET` | string | Your tailnet name, used in your own URLs. |
| `TIMEZONE` | string | IANA zone for times in check details. Default: the server's. |
| `ALERTS` | object | `{ enabled, afterMin: 3, chatId, url }`. `chatId` is for Telegram; `url` goes at the end of each message. `enabled: false` silences everything, failover notices included. |
| `QUIET_WINDOWS` | array | `{ label, start: 'HH:MM', end: 'HH:MM', tz, days? }`: no alerts or failover inside. `days` (e.g. `['Sun']`) limits it to the days it starts on; leave it out for every day. |
| `FAILOVER` | object | Two-copy setups only: `{ backupMachine, primary, backup }` (machine id plus display names). |
| `CADENCE` | object | Seconds between collections per kind (`probes`, `reporters`, `agent`, `ping`): `[someone viewing, nobody, backup on standby, wall screen open]`. |
| `GUEST_NAMES` / `guestName(vmid, raw)` | | Display names for Proxmox guests. |
| `GUEST_TS` | object | `vmid → { node }`: guests that are also tailnet nodes. |
| `EXPECTED_STOPPED` | string[] | Docker container names that are stopped on purpose (shown grey). |
| `QUOTA_ALERTS` | bool | Also list AI quota running low under *Needs attention*. |
| `QUOTA_GUARD_PRIORITY` | number | Optional. CLIProxyAPI accounts at this priority show as *preferred*, and as *paused by quota guard* when disabled. |
| `actionsFor(machineId, ctx)` | function | Update buttons. See below. |
| `controlsFor(machineId, ctx)` | function | Power and service buttons. |
| `terminalTargetsFor(machineId, ctx)` | function | Web terminal targets. |

### Machines

```js
{
  id: 'pve',                 // stable id, used everywhere (URLs: /#pve)
  name: 'Proxmox Host',      // display name
  host: 'pve',               // hostname shown under the name
  icon: 'server',            // server | desktop | laptop | gamepad | route
  site: 'Home',              // where it is (grouping text)
  os: 'Proxmox VE',
  role: 'What it does, one line',
  reporter: 'pve',           // 'pve' | 'linux' | 'mac' | 'winagent' | null
  ts: 'pve',                 // its Tailscale name: online status, ping
  optional: false,           // true = being off is normal (shown grey, never alerted)
  wide: true,                // full-width card (good for a Proxmox host)
  link: 'https://…',         // admin UI
  agent: 'http://…:9190',    // winagent only
  reporterConfig: { … },     // passed to the reporter, see below
}
```

How the dashboard reaches each machine is in `instance.json` → `access`, not here.

### `reporterConfig` per reporter

**`pve`** (runs as root on the Proxmox host)

| Key | Shape |
|---|---|
| `guest_services` | `[{ name, unit, vmid? , failAs? }]`: systemd units inside a container (`vmid`) or on the host (no `vmid`). `failAs: 'warn'` = amber, never alerted. |
| `guest_docker` | `[vmid, …]`: list Docker containers inside these LXCs. |
| `versions` | `[{ name, cmd, vmid? }]`: one line of output = the version (for `UPSTREAM`). |

Always collected: host stats, guests (with IPs and start at boot), storage, vzdump
jobs and their newest backup, SMART health (every 30 min), and apt updates for the
host and every running container (every 6 h).

**`linux`**

| Key | Shape |
|---|---|
| `mounts` | `['/', '/mnt/data']`: disks to show (default `['/']`). |
| `services` | `[{ name, unit, failAs? }]`: systemd units. |
| `docker` | `true`: list Docker containers (the SSH user must be allowed to run `docker`). |
| `ports` | `[{ name, kind: 'tcp', port, host? }]` or `[{ name, url, expect?, method?, headers?, timeout? }]` (no `proxy`, `json_expect` or `cache_min` here). |
| `files`, `versions` | As for `mac`. |

**`mac`**

| Key | Shape |
|---|---|
| `launchd` | `[{ label, name, periodic? }]`: `periodic: true` for jobs that run and exit (checked by last exit code). |
| `ports` | `[{ name, kind: 'tcp', port, host? }]` or `[{ name, url, expect?, method?, headers?, timeout?, proxy?, json_expect?, json_warn?, cache_min? }]`: checked *on* the machine, so `127.0.0.1` works. `json_expect: { key: value }` + `json_warn` = amber when the JSON answer doesn't match. `cache_min` = check at most that often. |
| `files` | `[{ name, path, max_age_min?, equals? }]`: a job writes a file and you check it's fresh (and, with `equals`, says e.g. `ok`). |
| `procs` | `[{ name, pattern }]`: `pgrep -f pattern`. |
| `docker` | `true`. |
| `versions` | `[{ name, cmd }]`. |
| `hub_quota` | `{ base, key_file, cache?, max_age_s? }`: AI subscription quota from a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) hub. `key_file` holds its management key and is read only on this Mac. |
| `standby_store` | Path to the backup copy's `data/store.json` (failover history for the activity log). |

**`winagent`**: no `reporterConfig`. Set `agent` to the agent's base URL. See [WINDOWS_AGENT.md](WINDOWS_AGENT.md).

**Your own reporter.** Any program that prints one JSON object with the same keys
(`stats`, `ports`, `files`, `guest_services`, `docker`, `updates`, …) works. Copy
`reporters/linux.py`, add it to `REPORTER_SRC` in `server.mjs`, and set
`reporter` to its name.

### Probes

Checks run *from the dashboard host*:

```js
{ id: 'jellyfin', name: 'Jellyfin', group: 'Media', machine: 'pve', type: 'http',
  url: 'https://jellyfin.example-tailnet.ts.net/health', expect: [200], link: 'https://…' }
{ id: 'ollama', …, type: 'tcp', host: '100.64.0.12', port: 11434 }
{ id: 'pihole-dns', …, type: 'dns', server: '{guest}', guest: 102, fallbackIp: '192.168.1.53', query: 'example.com' }
{ id: 'ts-exit', …, type: 'tailscale', node: 'vps', exitNode: true, routes: ['192.168.1.0/24'] }
```

- **`expect`**: HTTP codes that mean "up" (default: anything below 500). `401` = up, needs a token.
- **`method: 'POST'`**: sends `{}`. Useful for MCP endpoints.
- **`insecure: true`**: accept self-signed TLS (Proxmox, TrueNAS).
- **`describe(json)`**: a function that turns the response body into a short note, e.g. `(j) => `${j.count} items``.
- **`guest` + `{guest}`**: replaced by that Proxmox guest's current LAN IP (DHCP-proof). `fallbackIp` is used until it's known.
- **`failAs: 'warn'`**: amber instead of red, never alerted (for things with a fallback).
- **`machine`**: groups the check. If that machine is `optional` and off, the check shows grey.

### Update actions and controls

`actionsFor(machineId, ctx)` returns the update buttons for one machine. `ctx` holds
`updates` (the latest update check), `upstream` (release info by `UPSTREAM` id),
`guestNames` and `machine`. Each action:

```js
{ id: 'apt-host', label: 'Upgrade host packages (3)', tier: 'safe' | 'confirm' | 'manual',
  enabled: true, note: 'shown before you confirm', cmd: 'shell command run on the machine' }
```

- **`tier`**: `safe` runs on click. `confirm` asks you to type the machine's name. `manual` is shown only, with no button.
- **How it runs:** `cmd` runs detached on the machine (so it survives a dashboard restart), and its log streams live.
- **`agent: { what }`**: sends the job to a `winagent` instead.

`controlsFor(machineId, ctx)` works the same way. `ctx` has `data` (the latest report)
and `machine`. Each control has `group` (Power, Guests, Services, Containers),
`risky` (asks for confirmation), `kind: 'toggle'` + `on`, and `manual`.

**The browser never sends a command.** It sends a machine id and an action id, and
the server looks the command up here. Anything interpolated from the inventory
(container names, units, labels) is checked with a strict pattern first. Keep it
that way when you add your own.

### Sites

```js
{ group: 'Media', name: 'Jellyfin', url: 'https://…', note: 'one line', check: 'jellyfin' }   // reuse a probe
{ …, check: { url: 'https://…/health', expect: [200], insecure: false } }                     // its own check
{ …, check: null }                                                                             // just a link
```

### Upstream versions

```js
{ id: 'jellyfin', name: 'Jellyfin', machine: 'pve', current: 'pve:jellyfin', source: { github: 'jellyfin/jellyfin' }, hint: 'how to update' }
```

`current` = `<machineId>:<name in that reporter's versions>`. `source` is `{ github: 'owner/repo' }` (latest release) or `{ npm: 'package' }`.
Checked every 6 h.

## `instance.json`

| Key | Meaning |
|---|---|
| `role` | `primary` (default) or `standby` (the backup in a two-copy setup). |
| `hostLabel` | Where this copy runs, shown in the header and in alerts. |
| `port` | Default `3900`. Overridable with the `PORT` environment variable. |
| `listen` | Default `127.0.0.1`. Keep it, and put `tailscale serve` (or your proxy) in front. |
| `socket` | **Recommended.** A Unix socket path, e.g. `/opt/status/data/app.sock`, for `tailscale serve unix:<path>`. The Tailscale identity (who may run actions and the terminal) is believed **only** on this socket (mode 0600), so other local processes or Docker containers that can reach `127.0.0.1` can't pose as you. The TCP port stays for health checks and read-only use. |
| `publicUrl` | The URL you open (the web terminal accepts only this origin). |
| `tailnet` | Your tailnet name. |
| `tailscale` | `{ cli, socket?, serviceCli?, serviceSocket? }`, or `false` for no Tailscale on this host. |
| `service` | Two-copy setups only: the Tailscale Service, e.g. `svc:status`. |
| `healthListen` | Primary of a two-copy setup: `{ host: '0.0.0.0', port: 3901 }`, a health-only port for the backup. It answers `GET /api/health` only, but that includes the primary's LAN IPs and the names of hidden items: bind it to the tailnet address if your LAN isn't trusted. |
| `primaryNode`, `primaryHealthPort`, `primaryLan` | Backup only: how to reach the primary's health port. |
| `dataDir` | Where `store.json` lives. Default `./data`. |
| `sshKey` | The private key used for every SSH connection. |
| `access` | `machineId → { ssh: 'user@host' }` or `{ local: true }`. Machines without an entry aren't collected (Tailscale status still works). |
| `telegramTokenFile` | File holding the Telegram bot token. |
| `notify` | Script called with the alert text as its first argument (instead of Telegram). The backup also uses it for failover notices. |
| `lanViaSystemTools` | macOS hosts: probe LAN addresses through `/usr/bin/curl` and `nc`. macOS's Local Network privacy blocks Node. |
| `allowAnonymousActions` | Allow actions without a Tailscale identity. Only for setups behind your own authenticated proxy. |

## HTTP API

Everything the UI shows is in plain JSON:

| | |
|---|---|
| `GET /api/state` | Everything: summary, problems, machines, services, quota, events. |
| `GET /api/maps` | Map definitions + live status per node (`?defs=0`: status only). |
| `GET /api/health` | `{ ok, role, active, build }` |
| `POST /api/refresh` | `{ machine?, updates? }`: collect now. |
| `POST /api/action` | `{ machine, action, confirm? }` → `{ job }`; `GET /api/jobs/<id>` for the log. |
| `POST /api/ack` / `/api/unack` / `/api/stopped` | Hide a problem, or mark it stopped on purpose. |

POSTs need the `X-Status-UI: 1` header and an owner identity.
