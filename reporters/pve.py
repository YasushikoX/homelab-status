#!/usr/bin/env python3
"""Proxmox VE reporter for the status dashboard.

Runs as root on the Proxmox host (piped over SSH) and prints one JSON object:
host stats, guests, storage, disk health, in-guest service checks and, in
"full" mode, pending apt updates for the host and every running container.
Python 3.9 compatible, standard library only.
Argument 1: base64-encoded JSON config (see config.mjs).
"""
import base64
import json
import os
import re
import socket
import subprocess
import sys
import time

CFG = json.loads(base64.b64decode(sys.argv[1]).decode()) if len(sys.argv) > 1 else {}
MODE = CFG.get("mode", "fast")
NODE = socket.gethostname()
os.environ["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def run(cmd, timeout=30):
    try:
        p = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return -2, "", "timeout after %ss" % timeout
    except Exception as e:  # noqa: BLE001
        return -1, "", str(e)


def pvesh(path, timeout=20, extra=None):
    rc, out, err = run(["pvesh", "get", path, "--output-format", "json"] + (extra or []), timeout=timeout)
    if rc != 0:
        raise RuntimeError((err or out).strip()[:300])
    return json.loads(out)


def stats():
    s = pvesh("/nodes/%s/status" % NODE)
    rc, ver, _ = run(["pveversion"])
    out = {
        "hostname": NODE,
        "os": {"name": "Proxmox VE", "version": ver.strip().split("/")[1] if "/" in ver else ver.strip(),
               "kernel": s.get("kversion", "").split(" ")[1] if s.get("kversion") else None},
        "cpu_name": s.get("cpuinfo", {}).get("model"),
        "cores": s.get("cpuinfo", {}).get("cpus"),
        "cpu_percent": round(100 * float(s.get("cpu", 0)), 1),
        "load": [float(x) for x in s.get("loadavg", [])],
        "uptime_s": s.get("uptime"),
        "mem": {"total_bytes": s["memory"]["total"], "used_bytes": s["memory"]["used"]},
        "swap": {"total_bytes": s.get("swap", {}).get("total", 0), "used_bytes": s.get("swap", {}).get("used", 0)},
        "disks": [{"mount": "/", "total_bytes": s["rootfs"]["total"], "used_bytes": s["rootfs"]["used"]}],
    }
    rc, io, _ = run("grep -E '^cpu ' /proc/stat; sleep 1; grep -E '^cpu ' /proc/stat")
    lines = io.splitlines()
    if len(lines) == 2:
        a = [int(x) for x in lines[0].split()[1:]]
        b = [int(x) for x in lines[1].split()[1:]]
        total = sum(b) - sum(a)
        if total > 0:
            out["iowait_percent"] = round(100 * (b[4] - a[4]) / total, 1)
            out["cpu_percent"] = round(100 * (1 - (b[3] - a[3] + b[4] - a[4]) / total), 1)
    return out


def onboot(kind, vmid):
    """True/False from the guest's config (start at boot), None if unreadable."""
    path = "/etc/pve/nodes/%s/%s/%s.conf" % (NODE, "lxc" if kind == "lxc" else "qemu-server", vmid)
    try:
        with open(path) as f:
            for line in f:
                if line.startswith("["):  # snapshot sections follow; ignore them
                    break
                m = re.match(r"^onboot:\s*(\d)", line)
                if m:
                    return m.group(1) == "1"
        return False  # Proxmox default when the key is absent
    except OSError:
        return None


LAN_RE = re.compile(r"^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)")


def guest_ip(kind, vmid):
    """Current LAN IPv4 of a running guest (most get theirs from DHCP, so it can change)."""
    try:
        if kind == "lxc":
            rc, out, _ = run(["lxc-info", "-n", str(vmid), "-iH"], timeout=5)
            ips = [l.strip() for l in out.splitlines() if LAN_RE.match(l.strip())]
            ips.sort(key=lambda ip: ip.startswith("172."))  # docker bridges are 172.x
            return ips[0] if ips else None
        # VMs: match the NIC's MAC in the host's neighbour table
        mac = None
        with open("/etc/pve/nodes/%s/qemu-server/%s.conf" % (NODE, vmid)) as f:
            for line in f:
                if line.startswith("["):
                    break
                m = re.match(r"^net0:.*?=([0-9A-Fa-f:]{17})", line)
                if m:
                    mac = m.group(1).lower()
        if not mac:
            return None
        rc, out, _ = run(["ip", "-4", "neigh", "show"], timeout=5)
        for l in out.splitlines():
            parts = l.split()
            if mac in l.lower() and parts and LAN_RE.match(parts[0]) and "FAILED" not in l:
                return parts[0]
    except Exception:
        pass
    return None


def guests():
    res = []
    for kind in ("lxc", "qemu"):
        for g in pvesh("/nodes/%s/%s" % (NODE, kind)):
            res.append({
                "ip": guest_ip(kind, g["vmid"]) if g.get("status") == "running" else None,
                "onboot": onboot(kind, g["vmid"]),
                "vmid": int(g["vmid"]), "type": kind, "name": g.get("name"), "status": g.get("status"),
                "cpu_percent": round(100 * float(g.get("cpu", 0)), 1), "cpus": g.get("cpus"),
                "mem_bytes": g.get("mem"), "maxmem_bytes": g.get("maxmem"),
                "disk_bytes": g.get("disk") or None, "maxdisk_bytes": g.get("maxdisk"),
                "uptime_s": g.get("uptime"),
            })
    return sorted(res, key=lambda g: g["vmid"])


def storage():
    res = []
    for st in pvesh("/nodes/%s/storage" % NODE):
        res.append({"name": st["storage"], "type": st.get("type"), "active": bool(st.get("active")),
                    "used_bytes": st.get("used"), "total_bytes": st.get("total")})
    return res


def disk_health():
    res = []
    for d in pvesh("/nodes/%s/disks/list" % NODE, timeout=40):
        res.append({"dev": d.get("devpath"), "model": d.get("model"), "type": d.get("type"),
                    "health": d.get("health"), "size_bytes": d.get("size"), "wearout": d.get("wearout")})
    return res


def guest_services(items, running):
    res = []
    for s in items:
        vmid = s.get("vmid")
        if not vmid:
            rc, out, err = run(["systemctl", "is-active", s["unit"]], timeout=15)
            state = (out or err).strip()
            res.append({"name": s["name"], "vmid": None, "ok": state == "active", "detail": "systemd: " + state})
            continue
        if vmid not in running:
            res.append({"name": s["name"], "vmid": vmid, "ok": False, "detail": "container not running", "failAs": s.get("failAs")})
            continue
        rc, out, err = run(["pct", "exec", str(vmid), "--", "systemctl", "is-active", s["unit"]], timeout=15)
        state = (out or err).strip()
        res.append({"name": s["name"], "vmid": vmid, "ok": state == "active", "detail": "systemd: " + state, "failAs": s.get("failAs")})
    return res


def guest_docker(vmids, running):
    res = []
    for vmid in vmids:
        if vmid not in running:
            continue
        rc, out, err = run(["pct", "exec", str(vmid), "--", "docker", "ps", "-a", "--format", "{{json .}}"], timeout=20)
        for line in out.splitlines():
            try:
                c = json.loads(line)
            except ValueError:
                continue
            status = c.get("Status", "")
            health = "unhealthy" if "(unhealthy)" in status else ("healthy" if "(healthy)" in status else None)
            res.append({"vmid": vmid, "name": c.get("Names"), "state": c.get("State"), "status": status,
                        "health": health})
    return res


def versions(items, running):
    res = {}
    for v in items:
        vmid = v.get("vmid")
        if vmid and vmid not in running:
            res[v["name"]] = None
            continue
        cmd = ["pct", "exec", str(vmid), "--", "sh", "-c", v["cmd"]] if vmid else v["cmd"]
        rc, out, err = run(cmd, timeout=20)
        line = (out or err).strip().splitlines()
        res[v["name"]] = line[0].strip()[:120] if line and rc == 0 else None
    return res


APT_LINE = re.compile(r"^([^/\s]+)/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]")


def parse_apt(text):
    items = []
    for line in text.splitlines():
        m = APT_LINE.match(line.strip())
        if m:
            items.append({"name": m.group(1), "suite": m.group(2), "available": m.group(3),
                          "current": m.group(4), "security": "security" in m.group(2)})
    return items


def apt_updates(vmid=None):
    script = ("export DEBIAN_FRONTEND=noninteractive; apt-get update -qq 2>&1 | grep -E '^(E|W): ' | grep -v 'is not signed' | head -3; "
              "echo ===; apt list --upgradable 2>/dev/null; echo ===; "
              "[ -f /var/run/reboot-required ] && echo REBOOT_REQUIRED || true")
    cmd = ["pct", "exec", str(vmid), "--", "sh", "-c", script] if vmid else ["sh", "-c", script]
    rc, out, err = run(cmd, timeout=240)
    if "===" not in out:
        return {"items": [], "error": (err or out).strip()[-300:] or "apt failed (rc %s)" % rc}
    items = parse_apt(out.split("===")[1])
    warn = " | ".join(l.strip() for l in out.split("===")[0].splitlines() if l.strip())[:300] or None
    return {"items": items, "error": None, "warning": warn, "reboot_required": "REBOOT_REQUIRED" in out}


def backups():
    """Scheduled vzdump jobs and how their last runs went."""
    jobs = pvesh("/cluster/backup")
    tasks = pvesh("/nodes/%s/tasks" % NODE, extra=["--typefilter", "vzdump", "--limit", "20"]) if jobs else []
    files = {}
    for st in {j.get("storage") for j in jobs if j.get("storage")}:
        try:
            for f in pvesh("/nodes/%s/storage/%s/content" % (NODE, st), extra=["--content", "backup"]):
                v = int(f.get("vmid") or 0)
                if v and f.get("ctime", 0) > files.get((st, v), {}).get("ctime", 0):
                    files[(st, v)] = {"ctime": f.get("ctime"), "size": f.get("size")}
        except Exception:  # noqa: BLE001
            pass
    res = []
    for j in jobs:
        vmids = [int(x) for x in str(j.get("vmid", "")).split(",") if x.strip().isdigit()]
        res.append({
            "id": j.get("id"), "enabled": bool(int(j.get("enabled", 1))), "schedule": j.get("schedule"),
            "storage": j.get("storage"), "vmids": vmids, "all": bool(j.get("all")), "mode": j.get("mode"),
            "keep": j.get("prune-backups"), "next_run": j.get("next-run"), "comment": j.get("comment"),
            "latest": {str(v): files.get((j.get("storage"), v)) for v in vmids},
        })
    last = [{"start": t.get("starttime"), "end": t.get("endtime"), "status": t.get("status"), "id": t.get("id")} for t in tasks]
    return {"jobs": res, "tasks": last}


def main():
    result = {"ok": True, "mode": MODE, "collected_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    t0 = time.time()
    errors = {}
    steps = [("stats", stats), ("guests", guests), ("storage", storage), ("backups", backups)]
    if MODE == "full" or CFG.get("disks"):  # SMART reads take ~6 s; the server asks every 30 min
        steps.append(("disks", disk_health))
    for key, fn in steps:
        try:
            result[key] = fn()
        except Exception as e:  # noqa: BLE001
            errors[key] = str(e)[:300]
    running = {g["vmid"] for g in result.get("guests", []) if g["status"] == "running"}
    result["guest_services"] = guest_services(CFG.get("guest_services", []), running)
    result["guest_docker"] = guest_docker(CFG.get("guest_docker", []), running)
    result["versions"] = versions(CFG.get("versions", []), running)
    if MODE == "full":
        ups = {"host": apt_updates(None), "guests": {}}
        for g in result.get("guests", []):
            if g["type"] == "lxc" and g["vmid"] in running:
                ups["guests"][str(g["vmid"])] = apt_updates(g["vmid"])
        ups["checked_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        result["updates"] = ups
    if errors:
        result["errors"] = errors
    result["elapsed_ms"] = int((time.time() - t0) * 1000)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
