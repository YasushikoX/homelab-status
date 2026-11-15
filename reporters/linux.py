#!/usr/bin/env python3
"""Generic Linux reporter for Homelab Status (Debian/Ubuntu/Raspberry Pi OS,
and most other distributions; apt updates only where apt exists).

Piped over SSH (or run locally) and prints one JSON object: host stats,
systemd units, Docker containers, local port checks, file freshness, versions
and, in "full" mode, pending apt updates. Standard library only, Python 3.6+.
Argument 1: base64-encoded JSON config (a machine's reporterConfig, see docs/CONFIG.md).
"""
import base64
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

CFG = json.loads(base64.b64decode(sys.argv[1]).decode()) if len(sys.argv) > 1 else {}
MODE = CFG.get("mode", "fast")
os.environ["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:" + os.environ.get("PATH", "")
_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE  # local checks of self-signed admin UIs


def run(cmd, timeout=30):
    try:
        p = subprocess.run(cmd, shell=isinstance(cmd, str), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return -2, "", "timeout after %ss" % timeout
    except Exception as e:  # noqa: BLE001
        return -1, "", str(e)


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def os_release():
    info = {}
    for line in read("/etc/os-release").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            info[k] = v.strip().strip('"')
    return info


def cpu_times():
    for line in read("/proc/stat").splitlines():
        if line.startswith("cpu "):
            return [int(x) for x in line.split()[1:]]
    return None


def stats():
    rel = os_release()
    a = cpu_times()
    time.sleep(1)
    b = cpu_times()
    out = {
        "hostname": socket.gethostname(),
        "os": {"name": rel.get("NAME", "Linux"), "version": rel.get("VERSION_ID") or rel.get("VERSION"), "kernel": os.uname().release},
        "cores": os.cpu_count(),
        "load": list(os.getloadavg()),
        "uptime_s": int(float(read("/proc/uptime").split()[0] or 0)),
    }
    m = re.search(r"model name\s*:\s*(.+)", read("/proc/cpuinfo")) or re.search(r"^Model\s*:\s*(.+)", read("/proc/cpuinfo"), re.M)
    if m:
        out["cpu_name"] = m.group(1).strip()
    if a and b:
        total = sum(b) - sum(a)
        if total > 0:
            idle = (b[3] - a[3]) + (b[4] - a[4] if len(b) > 4 else 0)
            out["cpu_percent"] = round(100 * (1 - idle / total), 1)
            if len(b) > 4:
                out["iowait_percent"] = round(100 * (b[4] - a[4]) / total, 1)
    mem = {}
    for line in read("/proc/meminfo").splitlines():
        k, _, v = line.partition(":")
        mem[k] = int(v.split()[0]) * 1024 if v.split() else 0
    if mem.get("MemTotal"):
        out["mem"] = {"total_bytes": mem["MemTotal"], "used_bytes": mem["MemTotal"] - mem.get("MemAvailable", mem.get("MemFree", 0))}
        out["swap"] = {"total_bytes": mem.get("SwapTotal", 0), "used_bytes": mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)}
    disks = []
    for mount in CFG.get("mounts", ["/"]):
        try:
            st = os.statvfs(mount)
            disks.append({"mount": mount, "total_bytes": st.f_blocks * st.f_frsize, "used_bytes": (st.f_blocks - st.f_bfree) * st.f_frsize})
        except OSError:
            pass
    out["disks"] = disks
    t = read("/sys/class/thermal/thermal_zone0/temp").strip()
    if t.isdigit():
        out["cpu_temp_c"] = round(int(t) / 1000, 1)
    return out


def services(items):
    """systemd units on this machine (shown like Proxmox host services)."""
    res = []
    for s in items:
        rc, out, err = run(["systemctl", "is-active", s["unit"]], timeout=15)
        state = (out or err).strip() or "unknown"
        res.append({"name": s["name"], "vmid": None, "ok": state == "active", "detail": "systemd: " + state, "failAs": s.get("failAs")})
    return res


def docker():
    if not shutil.which("docker"):
        return {"error": "docker not installed"}
    rc, out, err = run(["docker", "ps", "-a", "--format", "{{json .}}"], timeout=20)
    if rc != 0:
        return {"error": (err or out).strip()[:300]}
    res = []
    for line in out.splitlines():
        try:
            c = json.loads(line)
        except ValueError:
            continue
        status = c.get("Status", "")
        health = "unhealthy" if "(unhealthy)" in status else ("healthy" if "(healthy)" in status else
                 ("starting" if "health: starting" in status else None))
        res.append({"name": c.get("Names"), "state": c.get("State"), "status": status, "health": health, "image": c.get("Image")})
    return {"containers": res}


def check_port(p):
    t0 = time.time()
    try:
        if p.get("kind") == "tcp":
            with socket.create_connection((p.get("host", "127.0.0.1"), int(p["port"])), timeout=4):
                pass
            return {"name": p["name"], "ok": True, "ms": int((time.time() - t0) * 1000), "detail": "port open"}
        method = p.get("method", "GET")
        headers = {"User-Agent": "homelab-status/1", "Content-Type": "application/json"}
        headers.update(p.get("headers") or {})
        req = urllib.request.Request(p["url"], method=method, data=b"{}" if method == "POST" else None, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=p.get("timeout", 5), context=_ctx) as r:
                code = r.status
        except urllib.error.HTTPError as e:
            code = e.code
        expect = p.get("expect")
        ok = (code in expect) if expect else code < 500
        return {"name": p["name"], "ok": ok, "code": code, "ms": int((time.time() - t0) * 1000),
                "detail": "HTTP 401 (token required, up)" if ok and code == 401 else "HTTP %s" % code}
    except Exception as e:  # noqa: BLE001
        msg = str(getattr(e, "reason", e))
        return {"name": p["name"], "ok": False, "ms": int((time.time() - t0) * 1000),
                "detail": "connection refused" if "refused" in msg.lower() else msg[:160]}


def check_file(f):
    path = os.path.expanduser(f["path"])
    try:
        st = os.stat(path)
    except OSError:
        return {"name": f["name"], "ok": False, "detail": "missing"}
    age_min = (time.time() - st.st_mtime) / 60
    ok = True
    detail = "updated %d min ago" % age_min if age_min < 120 else "updated %.1f h ago" % (age_min / 60)
    if f.get("max_age_min") and age_min > f["max_age_min"]:
        ok = False
        detail = "stale: " + detail
    if "equals" in f:
        content = read(path).strip()
        if content != f["equals"]:
            ok = False
        detail = "%s (%s)" % (content[:60], detail)
    return {"name": f["name"], "ok": ok, "age_min": round(age_min, 1), "detail": detail}


def versions(items):
    res = {}
    for v in items:
        rc, out, err = run(v["cmd"], timeout=20)
        line = (out or err).strip().splitlines()
        res[v["name"]] = line[0].strip()[:120] if line and rc == 0 else None
    return res


APT_LINE = re.compile(r"^([^/\s]+)/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]")


def apt_updates():
    if not shutil.which("apt-get"):
        return {"items": [], "error": None, "warning": "no apt on this machine: updates are not checked"}
    # apt-get update needs root; without it the list is as fresh as the last update anyone ran
    sudo = "" if os.geteuid() == 0 else "sudo -n "  # matches rule 2 in deploy/sudoers/status-dashboard
    script = ("export DEBIAN_FRONTEND=noninteractive; %s/usr/bin/apt-get update 2>&1 | grep -E '^(E|W): ' | head -3; "
              "echo ===; apt list --upgradable 2>/dev/null; echo ===; "
              "[ -f /var/run/reboot-required ] && echo REBOOT_REQUIRED || true") % sudo
    rc, out, err = run(["sh", "-c", script], timeout=240)
    if "===" not in out:
        return {"items": [], "error": (err or out).strip()[-300:] or "apt failed (rc %s)" % rc}
    items = []
    for line in out.split("===")[1].splitlines():
        m = APT_LINE.match(line.strip())
        if m:
            items.append({"name": m.group(1), "available": m.group(3), "current": m.group(4), "security": "security" in m.group(2)})
    warn = " | ".join(l.strip() for l in out.split("===")[0].splitlines() if l.strip())[:300] or None
    return {"items": items, "error": None, "warning": warn, "reboot_required": "REBOOT_REQUIRED" in out}


def main():
    t0 = time.time()
    result = {"ok": True, "mode": MODE, "collected_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    errors = {}
    try:
        result["stats"] = stats()
    except Exception as e:  # noqa: BLE001
        errors["stats"] = str(e)[:300]
    result["guest_services"] = services(CFG.get("services", []))
    if CFG.get("docker"):
        result["docker"] = docker()
    result["ports"] = [check_port(p) for p in CFG.get("ports", [])]
    result["files"] = [check_file(f) for f in CFG.get("files", [])]
    result["versions"] = versions(CFG.get("versions", []))
    rc, _, _ = run(["sudo", "-n", "-l", "/sbin/shutdown", "-r", "+1", "check"], timeout=10)
    result["sudo_power"] = rc == 0
    if MODE == "full":
        result["updates"] = {"host": apt_updates(), "checked_at": result["collected_at"]}
    if errors:
        result["errors"] = errors
    result["elapsed_ms"] = int((time.time() - t0) * 1000)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
