# Setup playbook

This is written for an AI coding agent (Claude Code, Codex, Cursor, …) that sets
Homelab Status up for its user. People can follow it too: every step is a
command plus a decision.

**Agent: read this whole file before you start.** Work through the phases in
order, keep the user informed with short updates, and keep a checklist of the
phases so the user can see where you are.

## Ground rules

1. **Discovery is read-only.** In phases 1–3 you only *look*: `tailscale status`,
   `ssh … 'uname -a'`, `pct list`, `docker ps`, `systemctl list-units`. Nothing that
   changes a machine.
2. **Ask before changing anything on any machine.** Before you install a
   package, create a container, add an SSH key, write a sudo rule, start a
   service or run `tailscale serve`, say exactly what you'll run and where, and
   wait for a yes. One yes covers the batch you described, not the next one.
3. **Secrets stay where they are.** Never print a token, password or private key
   in the chat or a log. Write secrets to files with `chmod 600` and reference
   the *path* in config. Don't paste the user's config, IPs or hostnames into
   web searches or any outside service.
4. **The user's setup stays local.** `config.mjs`, `maps.mjs`, `instance.json` and
   `data/` are git-ignored. Never commit them, and never edit the files in
   `examples/` to hold the user's real setup.
5. **Ask few, well-aimed questions.** Find what you can yourself, then ask only
   for decisions (which host, what matters, alerts yes/no). Ask several at once,
   with your recommendation first.
6. **If something is unclear or risky, stop and ask.** Prefer the simplest setup
   that works: one copy, no failover, until the user asks for more.

## Phase 0: Show the demo (2 minutes)

```bash
git clone https://github.com/YasushikoX/homelab-status && cd homelab-status
node --version          # needs 22 or newer
node server.mjs --demo  # http://localhost:3900 and http://localhost:3900/wall
```

Tell the user to open it and look around. The demo is a fictional lab defined
in `examples/config.mjs` and `examples/maps.mjs`. Those two files are also the
best reference for what you're about to write. Stop the demo when you're done
(Ctrl-C).

## Phase 1: Find the machines

Start with Tailscale. It knows almost every device:

```bash
tailscale status --json | jq -r '.Self, (.Peer[]) | [.HostName, .DNSName, .OS, (.TailscaleIPs[0]), .Online, .ExitNodeOption, ((.PrimaryRoutes // []) | join(","))] | @tsv'
tailscale status --json | jq -r '.MagicDNSSuffix'   # the tailnet name, e.g. example-tailnet.ts.net
```

No Tailscale? Ask the user to list their machines (name, IP, OS). Recommend
installing Tailscale, since it makes everything easier, but don't push.

For each machine, decide on a **reporter**:

| Machine | `reporter` | Needs |
|---|---|---|
| Proxmox VE host | `pve` | SSH as **root** (pvesh, pct) |
| Any other Linux (Ubuntu, Debian, Raspberry Pi OS, …) | `linux` | SSH as any user with `python3` |
| Mac | `mac` | SSH as the user (or local, if the dashboard runs on it) with `/usr/bin/python3` |
| Windows | `winagent` | An HTTP agent, see [WINDOWS_AGENT.md](WINDOWS_AGENT.md). Without one, use `null` |
| Phones, laptops that sleep, routers, VPSs you only want up/down for | `null` | Just its Tailscale name in `ts` |

Check SSH reachability from the machine you're on (read-only):

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 USER@HOST 'uname -srm; command -v pveversion >/dev/null && pveversion; sw_vers 2>/dev/null | head -2; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; command -v python3'
```

If SSH fails, note it. You'll set up keys in phase 5, after asking.

## Phase 2: Find what runs where (read-only)

Collect enough to write checks and draw maps. Run what fits each machine:

**Proxmox host** (as root):
```bash
pvesh get /cluster/resources --type vm --output-format json | jq -r '.[] | [.vmid, .type, .name, .status] | @tsv'
pvesh get /nodes/$(hostname)/storage --output-format json | jq -r '.[] | [.storage, .type, .active] | @tsv'
pvesh get /cluster/backup --output-format json | jq -r '.[] | [.id, .schedule, .storage, .vmid, .enabled] | @tsv'
for id in $(pct list | awk 'NR>1 && $2=="running" {print $1}'); do
  echo "== CT $id"; pct exec $id -- sh -c 'systemctl list-units --type=service --state=running --no-legend --plain | awk "{print \$1}" | grep -vE "^(systemd|dbus|getty|cron|ssh|rsyslog|networkd|postfix|console)" ; command -v docker >/dev/null && docker ps --format "docker {{.Names}} {{.Image}}"'
done
```

**Linux**:
```bash
systemctl list-units --type=service --state=running --no-legend --plain | awk '{print $1}'
docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null
ss -ltnp 2>/dev/null | awk 'NR>1 {print $4}' | sort -u
```

**Mac**:
```bash
launchctl list | awk 'NR>1 && $3 !~ /^com\.apple\./ {print $3}'
lsof -nP -iTCP -sTCP:LISTEN | awk 'NR>1 {print $1, $9}' | sort -u
docker ps --format '{{.Names}}  {{.Image}}' 2>/dev/null
```

**Web UIs on the tailnet**: `tailscale serve status` on each host, and URLs the user mentions.

Turn the results into a short inventory: per machine, its services and how to check each one (HTTP URL with expected codes, TCP port, DNS, systemd unit, container name).

## Phase 3: Decide with the user

Show the inventory as a compact table and ask, in one message:

1. **Where should the dashboard run?** Something always on. In order of preference:
   - a small **Proxmox LXC** (Debian 13, 1 core, 512 MB, 4 GB disk)
   - an always-on **Linux** box or Pi
   - an always-on **Mac**

   Recommend one based on what you found.
2. **What matters most?** Confirm the services you plan to check, and ask about any you couldn't classify.
3. **Alerts?** Telegram (they'll need a bot), a script of their own (ntfy, Pushover, …), or none for now.
4. **A backup copy with automatic failover?** Only if they have a second always-on machine. Recommend starting without it; it can be added later (see "Failover" below).
5. **Updates and controls from the dashboard?** Read-only is fine; buttons need SSH access with the rights to run those commands.

## Phase 4: Write the config

Work in the repo folder:

```bash
cp examples/config.mjs config.mjs
cp examples/maps.mjs maps.mjs
cp examples/instance.single.json instance.json
```

Then **rewrite** them for the user's lab ([CONFIG.md](CONFIG.md) documents every field):

- **`config.mjs`**:
  - Set `TAILNET` and `OWNER_LOGINS`: their Tailscale login, e.g. `name@github` or `name@gmail.com`; `tailscale status --json | jq -r '.User[]?.LoginName'` lists them.
  - Set `TIMEZONE`.
  - Fill `MACHINES` with a `reporterConfig` per machine.
  - Add `GUEST_NAMES`, `GUEST_TS`, `PROBES` and `SITES`.
  - Remove `FAILOVER` (single copy), and remove `hub_quota` unless they run CLIProxyAPI.
  - Keep `actionsFor`/`controlsFor`/`terminalTargetsFor` as they are (they work by reporter type) unless the user wants changes.
- **`instance.json`**:
  - `hostLabel`, `tailnet`, `publicUrl`.
  - The paths, for where it will run. The example is for a Linux box: `dataDir` `/opt/status/data`, `socket` `/opt/status/data/app.sock`, `sshKey` `/opt/status/.ssh/id_ed25519`, `tailscale.cli` `/usr/bin/tailscale`. On a Mac use e.g. `~/homelab-status/data`, `~/homelab-status/data/app.sock`, `~/.ssh/status_ed25519` and `/opt/homebrew/bin/tailscale` (or `/Applications/Tailscale.app/Contents/MacOS/Tailscale` for the App Store app).
  - `access`: how *this* dashboard host reaches each machine. Use `{ "ssh": "user@host" }`, or `{ "local": true }` for the machine it runs on.
  - Remove `telegramTokenFile` unless alerts are on.
- **`maps.mjs`**: draw their network, services and data flows. See [MAPS.md](MAPS.md) for the format and layout rules. Start with the network map; the other two are optional. If time is short, a map with fewer nodes that is correct beats a busy one.

Validate as you go:

```bash
node --check config.mjs && node --check maps.mjs
node -e "import('./config.mjs').then(c => console.log(c.MACHINES.map(m => m.id + ':' + m.reporter).join(' ')))"
```

Test each reporter against its machine *before* installing anything. It's read-only:

```bash
B64=$(printf '%s' '{"mode":"fast"}' | base64 | tr -d '\n')     # use the machine's reporterConfig + "mode" for a real test
ssh USER@HOST "python3 - $B64" < reporters/linux.py | head -c 800   # pve.py for Proxmox (as root), mac.py for Macs (/usr/bin/python3)
```

You can run the real dashboard from the repo folder before installing it as a
service. For this test set `dataDir` to `./data` and `socket` to `./data/app.sock` in `instance.json`, then:

```bash
node server.mjs   # then: curl -s localhost:3900/api/state | jq '.summary, [.machines[] | {id, status, reason}]'
```

## Phase 5: Install (ask first: list every step below that you'll take)

### A. Proxmox LXC or any Debian/Ubuntu box (recommended)

On Proxmox, create the container (ask first):
```bash
pveam update && pveam available --section system | grep debian-13   # pick the template name
pveam download local debian-13-standard_13.1-2_amd64.tar.zst        # example name
pct create 106 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst --hostname status --cores 1 --memory 512 --rootfs local-lvm:4 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp --unprivileged 1 --features nesting=1 --onboot 1 --start 1
```
Tailscale inside an unprivileged LXC needs the tun device. Add these to `/etc/pve/lxc/106.conf` and restart the container:
```
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

Then inside the box:
```bash
bash deploy/bootstrap-linux.sh            # Tailscale, Node 24, a "status" user + SSH key; prints the public key
tailscale up --hostname=status            # the user approves the login in their browser
# copy the app to /opt/status/app (the repo, plus config.mjs, maps.mjs, instance.json), owned by status
cp deploy/systemd/status-dashboard.service /etc/systemd/system/   # single copy: delete its ExecStopPost line
systemctl daemon-reload && systemctl enable --now status-dashboard
tailscale serve --bg --https=443 unix:/opt/status/data/app.sock   # the "socket" from instance.json
```

### B. A Mac
```bash
git clone https://github.com/YasushikoX/homelab-status ~/homelab-status   # plus config.mjs, maps.mjs, instance.json
# edit deploy/launchd/local.status.dashboard.plist (YOUR_HOME, node path), then:
cp deploy/launchd/local.status.dashboard.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.status.dashboard.plist
tailscale serve --bg --https=443 unix:$HOME/homelab-status/data/app.sock   # the "socket" from instance.json
```
On a Mac, set `"lanViaSystemTools": true` in `instance.json`. Without it, macOS's
Local Network privacy blocks Node from reaching LAN addresses.

**Why a Unix socket?** The dashboard believes the Tailscale identity header
(who may press buttons) only on the socket. Anything else on the host, such as
another user or a Docker container reaching `127.0.0.1`, could fake that header
on the TCP port. So point `tailscale serve` at the socket, never at `:3900`.
`tailscaled` runs as root on Linux and can open the 0600 socket. On a Mac, the
socket must belong to the same user as the Tailscale that serves it.

### SSH access to each machine (ask first)

Add the dashboard's public key (printed by the bootstrap; on a Mac, generate one
with `ssh-keygen -t ed25519 -f ~/.ssh/status_ed25519`) to `~/.ssh/authorized_keys`
on every machine with a reporter. Proxmox needs root's file. Restrict it to the
dashboard's address:

```
from="100.x.y.z,192.168.1.n" ssh-ed25519 AAAA… homelab-status@status
```

Then run `ssh -i <key> USER@HOST true` from the dashboard host, as the `status`
user, once per machine to accept the host keys.

### Optional extras (each needs its own yes)

- **Power buttons and package upgrades:** the sudo rules in
  [`deploy/sudoers/status-dashboard`](../deploy/sudoers/status-dashboard). The
  power rule is narrow. Explain that the apt rule is effectively root.
- **Telegram alerts:**
  1. The user creates a bot with @BotFather and sends it a message.
  2. Save the token to a file only the service can read (`chmod 600`), and set `telegramTokenFile` in `instance.json`.
  3. Find the chat id with `curl -s "https://api.telegram.org/bot$(cat FILE)/getUpdates" | jq '.result[0].message.chat.id'`. Don't print the token itself.
  4. Set `ALERTS = { enabled: true, chatId: '…' }` in `config.mjs`.

  Any other channel: set `notify` in `instance.json` to a script that takes the message as its first argument.
- **Windows:** see [WINDOWS_AGENT.md](WINDOWS_AGENT.md). There's no bundled agent; you can write one with the user from the contract, or list the PC with `reporter: null`.

## Phase 6: Verify and hand over

```bash
curl -s localhost:3900/api/state | jq '{summary: .summary | {machinesUp, machinesTotal, checksOk, checksTotal, problems: [.problems[] | "\(.name): \(.detail)"]}, machines: [.machines[] | "\(.id) \(.status) \(.reason)"]}'
curl -s 'localhost:3900/api/maps?defs=0' | jq '.missing'   # map bindings that point at nothing: fix them
journalctl -u status-dashboard -n 50 --no-pager            # or ~/Library/Logs/homelab-status.log on a Mac
```

Go through every problem. Most are a wrong URL, a wrong expected code (a 401 can
mean "up but needs a token": add it to `expect`), or a missing SSH key. Fix it,
then restart the service.

When it's clean, give the user:
- The URL, e.g. `https://status.<tailnet>.ts.net` (the `tailscale serve` address), and `/wall` for a spare screen.
- What's checked, in one short list, and what was left out and why.
- How to change things later: "ask me (or any agent) to edit `config.mjs` and restart the service".

## Failover (later, when the user asks)

Two copies: a **primary** (e.g. the LXC) and a **backup** (e.g. a Mac). Both
collect all the time. Only the active one is reachable at
`https://status.<tailnet>.ts.net`, through a Tailscale Service.

1. In the Tailscale admin console:
   - Create a tag (`tag:status`) and a Service `svc:status` (TCP 443).
   - Let `tag:status` hosts advertise it, through the service approval or an `autoApprovers` entry in the policy file. Check Tailscale's current docs for Services: <https://tailscale.com/kb/1552/tailscale-services>.
2. Primary:
   - Use `tailscale up --hostname=status-primary --advertise-tags=tag:status --operator=status`. The `--operator` lets the app's own user run `tailscale serve`, which it does to advertise and drain the service.
   - Start from `examples/instance.primary.json`: `service` is `svc:status`, and `healthListen` is on port 3901.
   - Keep `ExecStopPost` in the systemd unit.
   - Point the service at the app's socket **once, as root**. Tailscale lets only root (or an admin who can sudo) serve a Unix socket, so the app itself only advertises and drains it:
     `tailscale serve --service=svc:status --https=443 unix:/opt/status/data/app.sock`
3. Backup on a Mac:
   - A second, userspace Tailscale node from [`deploy/launchd/local.status.tailscaled.plist`](../deploy/launchd/local.status.tailscaled.plist).
   - Start from `examples/instance.standby.json`, with `primaryNode` set to the primary's Tailscale name.
   - Set its handler once (as the Mac's admin user), and drain it right away so the primary keeps serving:
     `tailscale --socket=$HOME/homelab-status/ts/tailscaled.sock serve --service=svc:status --https=443 unix:$HOME/homelab-status/data/app.sock`, then `… serve drain svc:status` (same `--socket`).
     A takeover then only has to advertise.
4. `config.mjs`:
   - Add `FAILOVER = { backupMachine, primary, backup }`.
   - On the backup machine's reporter, add a port check named `Status backup app :3900` (`http://127.0.0.1:3900/api/health`), plus `standby_store` pointing at the backup's `data/store.json`.
5. Test it: stop the primary, wait about a minute, and check the URL still answers (the backup's banner says it took over). Start the primary again; about two minutes later the backup hands back.

## Updating later

```bash
git pull                                 # code only; your config files are untouched
node --check server.mjs && node server.mjs --demo   # optional smoke test
# copy to the install folder if it's not the clone, then restart the service
```
