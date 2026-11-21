#!/usr/bin/env python3
"""macOS reporter for the status dashboard.

Runs on the target Mac (piped over SSH, or locally on the dashboard host) and
prints one JSON object: machine stats, local service checks and, in "full"
mode, pending updates. Python 3.9 compatible, standard library only.
Argument 1: base64-encoded JSON config (see config.mjs, machine.reporterConfig).
"""
import base64
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

CFG = json.loads(base64.b64decode(sys.argv[1]).decode()) if len(sys.argv) > 1 else {}
MODE = CFG.get("mode", "fast")
HOME = os.path.expanduser("~")
os.environ["PATH"] = ":".join([
    HOME + "/.orbstack/bin", "/opt/homebrew/bin", "/usr/local/bin", HOME + "/.local/bin",
    "/usr/bin", "/bin", "/usr/sbin", "/sbin", os.environ.get("PATH", ""),
])
os.environ.setdefault("HOMEBREW_NO_ENV_HINTS", "1")


def run(cmd, timeout=20, env=None):
    try:
        p = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True,
                           timeout=timeout, env=env)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return -2, "", "timeout after %ss" % timeout
    except Exception as e:  # noqa: BLE001
        return -1, "", str(e)


def sysctl(name):
    return run(["sysctl", "-n", name])[1].strip()


def num(s, default=None):
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- stats
def stats():
    out = {}
    rc, sw, _ = run(["sw_vers"])
    info = dict(re.findall(r"^(\w+):\s*(.+)$", sw, re.M))
    out["os"] = {"name": info.get("ProductName", "macOS"), "version": info.get("ProductVersion"),
                 "build": info.get("BuildVersion")}
    out["hostname"] = socket.gethostname()
    out["model"] = sysctl("hw.model")
    out["cpu_name"] = sysctl("machdep.cpu.brand_string")
    out["cores"] = int(num(sysctl("hw.ncpu"), 0))
    m = re.search(r"sec = (\d+)", sysctl("kern.boottime"))
    if m:
        out["uptime_s"] = int(time.time() - int(m.group(1)))
    out["load"] = list(os.getloadavg())

    rc, top, _ = run(["top", "-l", "2", "-n", "0", "-s", "1"], timeout=10)
    usages = re.findall(r"CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle", top)
    if usages:
        u, s, i = (float(x) for x in usages[-1])
        out["cpu_percent"] = round(100 - i, 1)

    total = int(num(sysctl("hw.memsize"), 0))
    rc, vm, _ = run(["vm_stat"])
    psize = int((re.search(r"page size of (\d+)", vm) or [None, 4096])[1])
    pages = {k.strip(): int(v) for k, v in re.findall(r"^([^:]+):\s+(\d+)\.", vm, re.M)}
    used = (pages.get("Pages active", 0) + pages.get("Pages wired down", 0)
            + pages.get("Pages occupied by compressor", 0)) * psize
    out["mem"] = {"total_bytes": total, "used_bytes": min(used, total)}
    rc, mp, _ = run(["memory_pressure", "-Q"], timeout=5)
    m = re.search(r"free percentage: (\d+)%", mp)
    if m:
        out["mem"]["pressure_free_percent"] = int(m.group(1))
    sw = sysctl("vm.swapusage")
    m = re.search(r"total = ([\d.]+)M\s+used = ([\d.]+)M", sw)
    if m:
        out["swap"] = {"total_bytes": int(float(m.group(1)) * 2**20), "used_bytes": int(float(m.group(2)) * 2**20)}

    disks = []
    for mount in ("/System/Volumes/Data",):
        if os.path.exists(mount):
            st = os.statvfs(mount)
            t = st.f_blocks * st.f_frsize
            disks.append({"mount": "/", "total_bytes": t, "used_bytes": t - st.f_bavail * st.f_frsize})
    out["disks"] = disks

    rc, batt, _ = run(["pmset", "-g", "batt"])
    m = re.search(r"(\d+)%;\s*([^;]+);", batt)
    if m:
        out["battery"] = {"percent": int(m.group(1)), "state": m.group(2).strip(),
                          "ac": "AC Power" in batt}
    rc, therm, _ = run(["pmset", "-g", "therm"])
    m = re.search(r"CPU_Speed_Limit\s*=\s*(\d+)", therm)
    if m:
        out["cpu_speed_limit"] = int(m.group(1))

    rc, ps, _ = run(["ps", "-Aceo", "pid=,pcpu=,rss=,comm=", "-r"])
    procs = []
    for line in ps.splitlines()[:6]:
        parts = line.split(None, 3)
        if len(parts) == 4:
            procs.append({"pid": int(parts[0]), "cpu": num(parts[1], 0), "rss_bytes": int(parts[2]) * 1024,
                          "name": parts[3]})
    out["top"] = procs
    return out


# ---------------------------------------------------------------- checks
def check_launchd(jobs):
    rc, out, _ = run(["launchctl", "list"])
    table = {}
    for line in out.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) == 3:
            table[parts[2]] = (parts[0], parts[1])
    res = []
    for j in jobs:
        label = j["label"]
        row = table.get(label)
        if row is None:
            res.append({"label": label, "loaded": False, "ok": False, "detail": "not loaded"})
            continue
        pid = None if row[0] == "-" else int(row[0])
        last = int(row[1]) if re.match(r"^-?\d+$", row[1]) else None
        if j.get("periodic"):
            ok = pid is not None or last == 0
            detail = "running now" if pid else ("last run ok" if last == 0 else "last exit %s" % last)
        else:
            ok = pid is not None
            detail = ("pid %s" % pid) if pid else ("not running, last exit %s" % last)
        res.append({"label": label, "loaded": True, "pid": pid, "last_exit": last, "ok": ok, "detail": detail})
    return res


def check_docker():
    rc, out, err = run(["docker", "ps", "-a", "--format", "{{json .}}"], timeout=15)
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
        labels = dict(kv.split("=", 1) for kv in (c.get("Labels") or "").split(",") if "=" in kv)
        res.append({"name": c.get("Names"), "state": c.get("State"), "status": status, "health": health,
                    "image": c.get("Image"), "project": labels.get("com.docker.compose.project")})
    return {"containers": res}


_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE


def check_port(p):
    t0 = time.time()
    try:
        if p.get("kind") == "tcp":
            with socket.create_connection((p.get("host", "127.0.0.1"), int(p["port"])), timeout=4):
                pass
            return {"name": p["name"], "ok": True, "ms": int((time.time() - t0) * 1000), "detail": "port open"}
        method = p.get("method", "GET")
        headers = {"User-Agent": "status-dashboard/1", "Content-Type": "application/json"}
        headers.update(p.get("headers") or {})
        req = urllib.request.Request(p["url"], method=method, data=b"{}" if method == "POST" else None, headers=headers)
        # external dependencies go through the same proxy their MCP uses
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": p["proxy"], "https": p["proxy"]}),
                                             urllib.request.HTTPSHandler(context=_ctx)) if p.get("proxy") else None
        body = b""
        try:
            with (opener.open(req, timeout=p.get("timeout", 5)) if opener else urllib.request.urlopen(req, timeout=5, context=_ctx)) as r:
                code = r.status
                if p.get("json_expect"):
                    body = r.read(65536)
        except urllib.error.HTTPError as e:
            code = e.code
        expect = p.get("expect")
        ok = (code in expect) if expect else code < 500
        res = {"name": p["name"], "ok": ok, "code": code, "ms": int((time.time() - t0) * 1000),
               "detail": "HTTP 401 (token required, up)" if ok and code == 401 else "HTTP %s" % code}
        # e.g. {"connected": true}: the port answers, but a dependency isn't there -> warn, not down
        if ok and p.get("json_expect"):
            try:
                got = json.loads(body.decode("utf-8", "replace"))
                bad = [k for k, v in p["json_expect"].items() if got.get(k) != v]
            except ValueError:
                bad = ["(not JSON)"]
            if bad:
                res.update(warn=True, detail=p.get("json_warn") or "unexpected %s" % ", ".join(bad))
            else:
                res["detail"] += " · " + ", ".join("%s: %s" % (k, json.dumps(v)) for k, v in p["json_expect"].items())
        return res
    except Exception as e:  # noqa: BLE001
        return {"name": p["name"], "ok": False, "ms": int((time.time() - t0) * 1000), "detail": str(e)[:200]}


PORT_CACHE = os.path.expanduser("~/.cache/homelab-status/port-cache.json")


def cached_port(p):
    """Checks of outside services (cache_min set) run at most every cache_min minutes."""
    if not p.get("cache_min"):
        return check_port(p)
    try:
        with open(PORT_CACHE) as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    hit = cache.get(p["name"])
    if hit and time.time() - hit.get("at", 0) < p["cache_min"] * 60:
        return hit["result"]
    res = check_port(p)
    cache[p["name"]] = {"at": time.time(), "result": res}
    try:
        os.makedirs(os.path.dirname(PORT_CACHE), exist_ok=True)
        with open(PORT_CACHE + ".tmp", "w") as f:
            json.dump(cache, f)
        os.replace(PORT_CACHE + ".tmp", PORT_CACHE)
    except OSError:
        pass
    return res


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
        try:
            content = open(path).read().strip()
        except OSError as e:
            content = "<unreadable: %s>" % e
        if content != f["equals"]:
            ok = False
        detail = "%s (%s)" % (content[:60], detail)
    return {"name": f["name"], "ok": ok, "age_min": round(age_min, 1), "detail": detail}


def check_proc(p):
    rc, out, _ = run(["pgrep", "-f", p["pattern"]])
    pids = [int(x) for x in out.split()] if rc == 0 else []
    return {"name": p["name"], "ok": bool(pids), "detail": ("pid %s" % pids[0]) if pids else "not running"}


def versions(items):
    res = {}
    for v in items:
        rc, out, err = run(v["cmd"], timeout=20)
        line = (out or err).strip().splitlines()
        res[v["name"]] = line[0].strip()[:120] if line and rc == 0 else None
    return res


# ---------------------------------------------------------------- AI subscription quota (CLIProxyAPI hub)
# Same calls the hub's own quota page makes: POST /v0/management/api-call with
# the account's auth_index; the hub substitutes $TOKEN$ itself, so no OAuth
# token ever leaves the hub. Only percentages and reset times are returned.
# The management key stays on this Mac. Results are cached so the two
# dashboard copies together query each provider at most once per max_age_s.
QUOTA_REQ = {
    "claude": ("https://api.anthropic.com/api/oauth/usage",
               {"User-Agent": "claude-cli/2.1.280 (external, cli)", "Authorization": "Bearer $TOKEN$",
                "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20"}),
    "codex": ("https://chatgpt.com/backend-api/wham/usage",
              {"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json",
               "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)"}),
    "kimi-ai": ("https://api.kimi.com/coding/v1/usages", {"Authorization": "Bearer $TOKEN$"}),
}
CLAUDE_LABELS = {"five_hour": "5-hour", "seven_day": "Weekly", "seven_day_opus": "Weekly · Opus",
                 "seven_day_sonnet": "Weekly · Sonnet", "seven_day_cowork": "Weekly · Cowork",
                 "seven_day_oauth_apps": "Weekly · apps", "seven_day_omelette": "Weekly · other",
                 "iguana_necktie": "Weekly · Fable"}
KIMI_LABELS = {"limit_5h": "5-hour", "limit_week": "Weekly", "limit_month_total": "Monthly",
               "limit_month_code": "Monthly · coding"}


def _iso_epoch(s):
    if not s:
        return None
    try:
        from datetime import datetime
        s = re.sub(r"(\.\d{6})\d*", r"\1", str(s)).replace("Z", "+00:00")
        return int(datetime.fromisoformat(s).timestamp())
    except ValueError:
        return None


def _win_label(seconds):
    if not seconds:
        return "Window"
    h = seconds / 3600
    return "5-hour" if abs(h - 5) < 0.1 else "Weekly" if abs(h - 168) < 1 else "Daily" if abs(h - 24) < 0.1 else "%g-hour" % h


def _norm_claude(b):
    out = []
    for k, v in (b or {}).items():
        if isinstance(v, dict) and v.get("utilization") is not None:
            out.append({"label": CLAUDE_LABELS.get(k, k.replace("_", " ")), "used": float(v["utilization"]),
                        "resets_at": _iso_epoch(v.get("resets_at")), "locked": v.get("locked_reason")})
    out.sort(key=lambda w: (0 if w["label"] == "5-hour" else 1, w["label"]))
    return out, {}


def _norm_codex(b):
    rl = (b or {}).get("rate_limit") or {}
    out = []
    for key in ("primary_window", "secondary_window"):
        w = rl.get(key)
        if w and w.get("used_percent") is not None:
            out.append({"label": _win_label(w.get("limit_window_seconds")), "used": float(w["used_percent"]),
                        "resets_at": w.get("reset_at")})
    extra = {"plan": (b or {}).get("plan_type"), "limit_reached": bool(rl.get("limit_reached")),
             "reset_credits": ((b or {}).get("rate_limit_reset_credits") or {}).get("available_count")}
    return out, extra


def _norm_kimi(b):
    out = []
    usages = (b or {}).get("usages") or {}
    for k, v in usages.items():
        if k == "limit_month_code" and v == usages.get("limit_month_total"):
            continue  # same as the monthly total; don't show it twice
        if isinstance(v, dict) and v.get("used_ratio") is not None:
            out.append({"label": KIMI_LABELS.get(k, k.replace("limit_", "").replace("_", " ")),
                        "used": round(float(v["used_ratio"]) * 100, 1), "resets_at": _iso_epoch(v.get("reset_time"))})
    return out, {}


# Antigravity (Google AI Pro/Ultra): quota comes in groups that run out separately
# (Gemini models; Claude and GPT models; Gemini 4 Argon), each with its own 5-hour
# and/or weekly bucket. Google sends no usage headers, so this is the only source.
AG_QUOTA_URLS = ("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
                 "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary")
AG_TIER_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
AG_HEADERS = {"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json",
              "User-Agent": "antigravity/hub/2.23.0 darwin/arm64"}
AG_GROUPS = {"gemini models": "Gemini", "claude and gpt models": "Claude/GPT"}
AG_WINDOWS = {"5h": "5-hour", "weekly": "Weekly"}


def _ag_group(model):
    """Which Antigravity pool a model draws from (to match cooldowns to quota groups)."""
    m = str(model or "").lower()
    return "Argon" if "argon" in m else "Gemini" if m.startswith("gemini") else "Claude/GPT"


def _call(api, auth_index, method, url, headers, data=None):
    body = {"authIndex": auth_index, "method": method, "url": url, "header": headers}
    if data is not None:
        body["data"] = json.dumps(data)
    r = api("POST", "/api-call", body)
    b = r.get("body")
    b = json.loads(b) if isinstance(b, str) and b.strip()[:1] in "{[" else b
    if int(r.get("status_code") or 0) != 200:
        raise RuntimeError("HTTP %s" % r.get("status_code"))
    return b


def _norm_antigravity(b):
    out = []
    for g in (b or {}).get("groups") or []:
        name = str(g.get("displayName") or "Quota")
        group = AG_GROUPS.get(name.lower(), re.sub(r"^Gemini \d+(\.\d+)? ", "", name))
        for k in g.get("buckets") or []:
            frac = k.get("remainingFraction")
            if frac is None:
                continue
            win = str(k.get("window") or "").lower()
            out.append({"label": AG_WINDOWS.get(win, k.get("displayName") or win or "Limit"), "group": group,
                        "used": round((1 - float(frac)) * 100, 1), "resets_at": _iso_epoch(k.get("resetTime"))})
    order = list(dict.fromkeys(w["group"] for w in out))  # keep Google's group order
    out.sort(key=lambda w: (order.index(w["group"]), 0 if w["label"] == "5-hour" else 1))
    return out


def _fetch_antigravity(api, f, old):
    b = None
    for url in AG_QUOTA_URLS:  # the hub's own quota page tries the daily endpoint first
        try:
            b = _call(api, f["auth_index"], "POST", url, AG_HEADERS, {"project": f.get("project_id")})
            if b and b.get("groups"):
                break
        except Exception as e:  # noqa: BLE001
            err = e
    if not (b and b.get("groups")):
        raise err if b is None else RuntimeError("no quota groups")
    extra = {}
    # the plan name barely changes: ask at most every 6 hours
    if old and old.get("plan") and time.time() - old.get("plan_at", 0) < 6 * 3600:
        extra = {"plan": old["plan"], "plan_at": old["plan_at"]}
    else:
        try:
            t = _call(api, f["auth_index"], "POST", AG_TIER_URL, AG_HEADERS,
                      {"cloudaicompanionProject": f.get("project_id"),
                       "metadata": {"ideType": "ANTIGRAVITY", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"}})
            tier = (t.get("paidTier") or t.get("currentTier") or {}).get("name")
            if tier:
                extra = {"plan": re.sub(r"^Google AI ", "", tier), "plan_at": int(time.time())}
        except Exception:  # noqa: BLE001
            pass
    return _norm_antigravity(b), extra


def _from_signals(provider, sig):
    """Fallback: the usage the hub recorded from response headers (no provider call)."""
    out = []
    if provider == "claude":
        for tag, label in (("5h", "5-hour"), ("7d", "Weekly")):
            u = sig.get("Anthropic-Ratelimit-Unified-%s-Utilization" % tag)
            r = sig.get("Anthropic-Ratelimit-Unified-%s-Reset" % tag)
            if u is not None:
                out.append({"label": label, "used": round(float(u) * 100, 1), "resets_at": int(float(r)) if r else None})
    elif provider == "codex":
        for p in ("Primary", "Secondary"):
            u, mins = sig.get("X-Codex-%s-Used-Percent" % p), sig.get("X-Codex-%s-Window-Minutes" % p)
            if u is not None and mins not in (None, "0"):
                r = sig.get("X-Codex-%s-Reset-At" % p)
                out.append({"label": _win_label(int(mins) * 60), "used": float(u), "resets_at": int(r) if r else None})
    return out


def hub_quota(q):
    cache = os.path.expanduser(q.get("cache", "~/.cache/homelab-status/hub-quota.json"))
    try:
        with open(cache) as f:
            cached = json.load(f)
        if time.time() - cached.get("fetched_at", 0) < q.get("max_age_s", 240):
            cached["cached"] = True
            return cached
    except (OSError, ValueError):
        cached = None
    try:
        key = open(os.path.expanduser(q["key_file"])).read().strip()
    except OSError as e:
        return {"error": "management key unreadable: %s" % e, "accounts": []}
    base = q["base"].rstrip("/")

    def api(method, path, body=None):
        req = urllib.request.Request(base + path, json.dumps(body).encode() if body is not None else None,
                                     {"Authorization": "Bearer " + key, "Content-Type": "application/json",
                                      "User-Agent": "status-dashboard/1"}, method=method)
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.load(r)

    try:
        files = api("GET", "/auth-files").get("files", [])
    except Exception as e:  # noqa: BLE001
        res = cached or {"accounts": []}
        res["error"] = "hub management API: %s" % str(e)[:200]
        return res
    accounts = []
    for f in files:
        prov = f.get("provider") or f.get("type")
        acc = {"provider": prov, "account": f.get("email") or f.get("label") or f.get("name"),
               "disabled": bool(f.get("disabled")), "status": f.get("status"), "unavailable": bool(f.get("unavailable")),
               "priority": f.get("priority"),
               "cooldowns": [{"scope": c.get("scope"), "model": c.get("model_key"), "reason": c.get("reason"),
                              "status": c.get("http_status"), "until": _iso_epoch(c.get("retry_at")),
                              "group": _ag_group(c.get("model_key")) if prov == "antigravity" else None}
                             for c in (f.get("cooldowns") or [])][:20],
               "success": f.get("success"), "failed": f.get("failed"), "windows": [], "source": None, "error": None}
        req = QUOTA_REQ.get(prov)
        if prov == "antigravity" and f.get("auth_index") is not None:
            old = next((a for a in (cached or {}).get("accounts", []) if a.get("provider") == prov and a.get("account") == acc["account"]), None)
            try:
                acc["windows"], extra = _fetch_antigravity(api, f, old)
                acc.update(extra)
                acc["source"] = "live"
            except Exception as e:  # noqa: BLE001
                acc["error"] = str(e)[:160]
        elif req and f.get("auth_index") is not None:
            try:
                r = api("POST", "/api-call", {"authIndex": f["auth_index"], "method": "GET", "url": req[0], "header": req[1]})
                body = r.get("body")
                body = json.loads(body) if isinstance(body, str) and body.strip()[:1] in "{[" else body
                if int(r.get("status_code") or 0) != 200:
                    raise RuntimeError("HTTP %s" % r.get("status_code"))
                norm = {"claude": _norm_claude, "codex": _norm_codex, "kimi-ai": _norm_kimi}[prov]
                acc["windows"], extra = norm(body)
                acc.update(extra)
                acc["source"] = "live"
            except Exception as e:  # noqa: BLE001
                acc["error"] = str(e)[:160]
        if not acc["windows"]:
            sig = (f.get("quota") or {}).get("signals") or {}
            acc["windows"] = _from_signals(prov, sig)
            if acc["windows"]:
                acc["source"] = "headers"
                acc["observed_at"] = _iso_epoch((f.get("quota") or {}).get("observed_at"))
        accounts.append(acc)
    res = {"fetched_at": int(time.time()), "accounts": accounts, "error": None}
    try:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        tmp = cache + ".tmp"
        with open(tmp, "w") as f:
            json.dump(res, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, cache)
    except OSError:
        pass
    return res


# ---------------------------------------------------------------- updates
def softwareupdates():
    rc, out, err = run(["softwareupdate", "-l"], timeout=180)
    text = out + err
    items = []
    for m in re.finditer(r"\* Label: (.+)\n\s*Title: ([^,]+), Version: ([^,]+),(.*)", text):
        rest = m.group(4)
        items.append({"label": m.group(1).strip(), "name": m.group(2).strip(), "available": m.group(3).strip(),
                      "restart": "restart" in rest.lower(), "recommended": "Recommended: YES" in rest})
    error = None
    if rc != 0 and not items and "No new software available" not in text:
        error = text.strip()[-300:]
    return {"items": items, "error": error}


def brew_outdated():
    brew = None
    for b in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew"):
        if os.path.exists(b):
            brew = b
    if not brew:
        return None
    rc, out, err = run([brew, "outdated", "--json=v2"], timeout=300)
    try:
        d = json.loads(out)
    except ValueError:
        return {"items": [], "error": (err or out).strip()[-300:]}
    items = []
    for f in d.get("formulae", []):
        items.append({"name": f["name"], "current": ", ".join(f.get("installed_versions", [])),
                      "available": f.get("current_version"), "pinned": f.get("pinned", False), "type": "formula"})
    for c in d.get("casks", []):
        items.append({"name": c["name"], "current": ", ".join(c.get("installed_versions", [])),
                      "available": c.get("current_version"), "type": "cask"})
    return {"items": items, "error": None}


def main():
    result = {"ok": True, "mode": MODE, "collected_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    t0 = time.time()
    result["stats"] = stats()
    result["launchd"] = check_launchd(CFG.get("launchd", []))
    if CFG.get("docker"):
        result["docker"] = check_docker()
    result["ports"] = [cached_port(p) for p in CFG.get("ports", [])]
    result["files"] = [check_file(f) for f in CFG.get("files", [])]
    result["procs"] = [check_proc(p) for p in CFG.get("procs", [])]
    result["versions"] = versions(CFG.get("versions", []))
    if CFG.get("hub_quota"):
        result["hub_quota"] = hub_quota(CFG["hub_quota"])
    # the dashboard's narrow sudo rule (/etc/sudoers.d/status-dashboard): reboot / shutdown / cancel only
    rc, _, _ = run(["sudo", "-n", "-l", "/sbin/shutdown", "-r", "+1", "check"], timeout=10)
    result["sudo_power"] = rc == 0
    if CFG.get("standby_store"):
        try:
            with open(os.path.expanduser(CFG["standby_store"])) as f:
                role = json.load(f).get("role") or {}
            result["standby_role"] = {"active": role.get("active"), "events": (role.get("events") or [])[-30:]}
        except (OSError, ValueError) as e:
            result["standby_role"] = {"error": str(e)[:200]}
    if MODE == "full":
        result["updates"] = {"macos": softwareupdates(), "brew": brew_outdated(),
                             "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    result["elapsed_ms"] = int((time.time() - t0) * 1000)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
