# The Windows agent contract

Windows has no SSH-and-Python reporter. Instead the dashboard talks to a small
HTTP agent on the PC (`reporter: 'winagent'`, `agent: 'http://<tailnet-ip>:9190'`).
There's no bundled agent: any program that answers the endpoints below works.
It can be PowerShell, Python, Go or anything else, and your AI can write one from
this page in a few minutes.

**Security:** listen on the PC's Tailscale address only (or firewall the port
to the dashboard host's tailnet IPs). The agent can install updates and restart
the PC, so nothing else should reach it.

## Endpoints

### `GET /health` → `200`
Anything. Handy as a probe target.

### `GET /stats`
```json
{
  "hostname": "GAMING-PC",
  "os": "Windows 11 Pro 25H2",
  "cpu": { "name": "AMD Ryzen 7 9800X3D", "threads": 16, "percent": 6.5 },
  "uptime_s": 7200,
  "mem": { "total_bytes": 68719476736, "used_bytes": 15032385536 },
  "disks": [{ "mount": "C:", "total_bytes": 2000000000000, "used_bytes": 900000000000 }],
  "gpu": [{ "name": "NVIDIA GeForce RTX 4080", "util_percent": 4, "temp_c": 41 }],
  "user": "alex",
  "ollama": { "running": true },
  "top": [{ "pid": 1234, "cpu": 3.1, "rss_bytes": 400000000, "name": "steam.exe" }]
}
```
All fields are optional except `cpu.percent` and `mem`. A GPU at 85 °C or more raises a warning.

### `GET /updates` (and `?refresh=1` to check now)
```json
{
  "checked_at": "2026-11-14T09:00:00Z",
  "winget": [{ "name": "Steam", "current": "2.10.91.91", "available": "2.10.91.94" }],
  "windows_update": [{ "title": "2026-11 Cumulative Update", "kb": "KB5070000", "severity": "Important", "reboot_required": true }],
  "windows_update_error": null,
  "pending_reboot": false
}
```
Read every 6 hours. Cache the result; a Windows Update scan is slow.

### `POST /update` `{ "what": "winget-all" }` → `{ "job": "<id>" }`
Starts a job and returns right away. `what` comes from the `agent: { what }` of
an action in `config.mjs`. Only accept values you know.

### `GET /jobs/<id>`
```json
{ "status": "running" | "ok" | "failed", "log": "full output so far", "exit_code": 0 }
```
The dashboard polls this every 3 s and streams `log` into the UI.

### `POST /power` `{ "action": "restart" | "shutdown" | "cancel", "delay_s": 60 }`
Schedule a restart or shutdown (`shutdown /r /t 60`, `shutdown /s /t 60`), or
cancel one (`shutdown /a`). Reply with any text. It's shown in the job log.
