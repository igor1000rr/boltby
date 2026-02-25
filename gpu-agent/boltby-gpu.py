#!/usr/bin/env python3
"""
Boltby GPU Agent — Десктоп приложение для управления GPU нодой.

Нативное окно (pywebview), системный трей, Flask API backend.
Все кнопки в UI — никакой консоли.
"""

import os
import sys
import json
import time
import socket
import subprocess
import threading
import shutil
import tempfile
from pathlib import Path
from datetime import datetime

# ─── Auto-install dependencies ───

def ensure_deps():
    """Install missing Python packages silently."""
    needed = []
    for pkg, imp in [("flask","flask"), ("requests","requests")]:
        try:
            __import__(imp)
        except ImportError:
            needed.append(pkg)
    if needed:
        print(f"Installing: {', '.join(needed)}...")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install"] + needed + ["--quiet", "--break-system-packages"],
            stderr=subprocess.DEVNULL
        )

ensure_deps()

from flask import Flask, render_template, jsonify, request, Response
import requests as http_requests

# ═══════════════════════════════════════
#  Config
# ═══════════════════════════════════════

APP_VERSION = "1.0.0"
APP_PORT = 7860
CONFIG_DIR = Path.home() / ".config" / "boltby-gpu"
CONFIG_FILE = CONFIG_DIR / "config.json"
LOG_FILE = CONFIG_DIR / "agent.log"

DEFAULT_CONFIG = {
    "ollama_host": "0.0.0.0",
    "ollama_port": 11434,
    "autostart_ollama": True,
    "autostart_agent": True,
    "vps_connections": [],
    "wireguard": {
        "enabled": False,
        "interface": "wg0",
        "local_ip": "10.7.0.2",
        "peer_ip": "10.7.0.1",
    },
    "popular_models": [
        {"name": "qwen2.5-coder:32b", "desc": "Лучший для кода, 32B", "vram": "20GB+"},
        {"name": "qwen2.5-coder:14b", "desc": "Быстрый для кода, 14B", "vram": "10GB+"},
        {"name": "qwen2.5-coder:7b", "desc": "Компактный, 7B", "vram": "6GB+"},
        {"name": "qwen3-coder:30b-a3b", "desc": "MoE 30B (3B active)", "vram": "12GB+"},
        {"name": "devstral:24b", "desc": "Mistral для кода", "vram": "16GB+"},
        {"name": "deepseek-r1:14b", "desc": "Reasoning модель", "vram": "10GB+"},
        {"name": "deepseek-coder-v2:16b", "desc": "DeepSeek Coder V2", "vram": "10GB+"},
    ],
}

config = {}
log_buffer = []
LOG_MAX = 500
gpu_cache = {}
gpu_lock = threading.Lock()

# ═══════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════

def load_config():
    global config
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if CONFIG_FILE.exists():
        try:
            config = {**DEFAULT_CONFIG, **json.loads(CONFIG_FILE.read_text())}
        except Exception:
            config = DEFAULT_CONFIG.copy()
    else:
        config = DEFAULT_CONFIG.copy()
    save_config()

def save_config():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(config, indent=2, ensure_ascii=False))

def log(msg, level="INFO"):
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] [{level}] {msg}"
    log_buffer.append(line)
    if len(log_buffer) > LOG_MAX:
        log_buffer.pop(0)
    print(line)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass

def run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, r.stdout.strip(), r.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, "", "timeout"
    except Exception as e:
        return False, "", str(e)

def run_sudo(cmd, timeout=60):
    """Run command as root. Uses pkexec with temp script for GUI sudo."""
    if os.geteuid() == 0:
        return run(cmd, timeout)
    # Write cmd to temp script to avoid quoting issues with pkexec
    try:
        fd, path = tempfile.mkstemp(suffix=".sh", prefix="boltby_")
        with os.fdopen(fd, "w") as f:
            f.write("#!/bin/bash\n" + cmd + "\n")
        os.chmod(path, 0o755)
        ok, out, err = run(f"pkexec {path}", timeout)
        os.unlink(path)
        if not ok:
            # Fallback: try without sudo (may work if running as root via systemd)
            return run(cmd, timeout)
        return ok, out, err
    except Exception:
        return run(cmd, timeout)

_ip_cache = {"ips": None, "ts": 0}
_IP_CACHE_TTL = 120  # refresh external IP every 2 min max

def get_local_ips():
    """Get all local IPs grouped by type. Caches external IP."""
    now = time.time()
    # Return cached if fresh
    if _ip_cache["ips"] and (now - _ip_cache["ts"]) < _IP_CACHE_TTL:
        return _ip_cache["ips"]

    ips = {"private": [], "wireguard": [], "external": None}
    # Internal IPs (fast, local)
    ok, out, _ = run("ip -4 -o addr show scope global 2>/dev/null")
    if ok:
        for line in out.split("\n"):
            parts = line.split()
            if len(parts) >= 4:
                iface = parts[1]
                ip = parts[3].split("/")[0]
                if iface.startswith("wg"):
                    ips["wireguard"].append({"ip": ip, "iface": iface})
                else:
                    ips["private"].append({"ip": ip, "iface": iface})
    # External IP (slow, cached)
    try:
        r = http_requests.get("https://ifconfig.me", timeout=3)
        ips["external"] = r.text.strip()
    except Exception:
        # Keep old external IP if available
        if _ip_cache["ips"]:
            ips["external"] = _ip_cache["ips"].get("external")
    _ip_cache["ips"] = ips
    _ip_cache["ts"] = now
    return ips

def get_primary_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ═══════════════════════════════════════
#  GPU
# ═══════════════════════════════════════

def gpu_info():
    ok, out, _ = run(
        "nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free,"
        "temperature.gpu,power.draw,power.limit,utilization.gpu,driver_version,fan.speed,"
        "pstate,clocks.current.graphics,clocks.max.graphics "
        "--format=csv,noheader,nounits", 5
    )
    if not ok:
        return []
    gpus = []
    for line in out.strip().split("\n"):
        p = [x.strip() for x in line.split(",")]
        if len(p) >= 12:
            total = int(float(p[2]))
            used = int(float(p[3]))
            gpus.append({
                "index": int(p[0]),
                "name": p[1],
                "vram_total": total,
                "vram_used": used,
                "vram_free": int(float(p[4])),
                "vram_pct": round(used / total * 100) if total else 0,
                "temp": _num(p[5]),
                "power": _num(p[6]),
                "power_limit": _num(p[7]),
                "util": _num(p[8]),
                "driver": p[9],
                "fan": p[10] if p[10] != "[N/A]" else "N/A",
                "pstate": p[11] if len(p) > 11 else "",
                "clock": _num(p[12]) if len(p) > 12 else 0,
                "clock_max": _num(p[13]) if len(p) > 13 else 0,
            })
    return gpus

def _num(s):
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return 0

def gpu_processes():
    ok, out, _ = run(
        "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits", 5
    )
    if not ok or not out:
        return []
    procs = []
    for line in out.strip().split("\n"):
        p = [x.strip() for x in line.split(",")]
        if len(p) >= 3:
            procs.append({"pid": p[0], "name": p[1], "vram": _num(p[2])})
    return procs

def gpu_monitor_thread():
    while True:
        try:
            data = {"gpus": gpu_info(), "procs": gpu_processes(), "ts": time.time()}
            with gpu_lock:
                gpu_cache.update(data)
        except Exception:
            pass
        time.sleep(3)


# ═══════════════════════════════════════
#  Ollama
# ═══════════════════════════════════════

def olla_port():
    return config.get("ollama_port", 11434)

def olla_url(path=""):
    return f"http://127.0.0.1:{olla_port()}{path}"

def olla_installed():
    return shutil.which("ollama") is not None

def olla_version():
    ok, out, _ = run("ollama --version")
    return out.replace("ollama version is ", "").strip() if ok else ""

def olla_running():
    try:
        r = http_requests.get(olla_url("/api/tags"), timeout=3)
        return r.ok
    except Exception:
        return False

def olla_status():
    installed = olla_installed()
    running = olla_running() if installed else False
    models = 0
    if running:
        try:
            r = http_requests.get(olla_url("/api/tags"), timeout=3)
            models = len(r.json().get("models", []))
        except Exception:
            pass
    return {
        "installed": installed,
        "running": running,
        "version": olla_version() if installed else "",
        "models": models,
        "port": olla_port(),
    }

def olla_install():
    log("Installing Ollama...")
    ok, out, err = run("curl -fsSL https://ollama.ai/install.sh | sh", 180)
    if ok:
        log("Ollama installed OK")
        olla_configure()
    else:
        log(f"Ollama install FAILED: {err}", "ERROR")
    return ok, (out + "\n" + err).strip()

def olla_configure():
    """Configure Ollama systemd to listen externally."""
    host = config.get("ollama_host", "0.0.0.0")
    port = olla_port()
    override = f'[Service]\nEnvironment="OLLAMA_HOST={host}:{port}"\nEnvironment="OLLAMA_ORIGINS=*"\n'
    d = "/etc/systemd/system/ollama.service.d"
    conf_path = f"{d}/boltby.conf"
    # Write override to temp file, then move with sudo
    try:
        fd, tmp = tempfile.mkstemp(suffix=".conf", prefix="boltby_olla_")
        with os.fdopen(fd, "w") as f:
            f.write(override)
        ok, _, _ = run_sudo(f"mkdir -p {d} && cp {tmp} {conf_path} && chmod 644 {conf_path} && systemctl daemon-reload")
        os.unlink(tmp)
    except Exception:
        ok = False
    if ok:
        log(f"Ollama configured: {host}:{port}")
    return ok

def olla_start():
    olla_configure()
    ok, _, err = run_sudo("systemctl start ollama")
    if not ok:
        ok, _, _ = run("nohup ollama serve > /dev/null 2>&1 &", 3)
    log(f"Ollama start: {'OK' if ok else 'FAIL'}")
    return ok

def olla_stop():
    run_sudo("systemctl stop ollama")
    run("pkill -f 'ollama serve'", 3)
    log("Ollama stopped")
    return True

def olla_restart():
    olla_stop()
    time.sleep(1)
    return olla_start()

def olla_models():
    try:
        r = http_requests.get(olla_url("/api/tags"), timeout=5)
        return [{
            "name": m["name"],
            "size": m.get("size", 0),
            "gb": round(m.get("size", 0) / 1073741824, 1),
            "family": m.get("details", {}).get("family", ""),
            "params": m.get("details", {}).get("parameter_size", ""),
            "quant": m.get("details", {}).get("quantization_level", ""),
        } for m in r.json().get("models", [])]
    except Exception:
        return []

def olla_running_models():
    try:
        r = http_requests.get(olla_url("/api/ps"), timeout=5)
        return r.json().get("models", [])
    except Exception:
        return []

def olla_pull(name):
    """Stream pull progress."""
    log(f"Pulling model: {name}")
    try:
        r = http_requests.post(olla_url("/api/pull"), json={"name": name, "stream": True}, stream=True, timeout=3600)
        for line in r.iter_lines():
            if line:
                yield json.loads(line)
    except Exception as e:
        yield {"error": str(e)}

# ─── Background Pull (for remote triggers from VPS) ───

_pull_jobs = {}  # name -> {status, progress, total, error, done}
_pull_jobs_lock = threading.Lock()

def _bg_pull_worker(name):
    """Pull model in background, track progress."""
    with _pull_jobs_lock:
        _pull_jobs[name] = {"status": "starting", "progress": 0, "total": 0, "error": "", "done": False}
    log(f"Background pull started: {name}")
    try:
        r = http_requests.post(olla_url("/api/pull"), json={"name": name, "stream": True}, stream=True, timeout=3600)
        for line in r.iter_lines():
            if line:
                d = json.loads(line)
                with _pull_jobs_lock:
                    _pull_jobs[name]["status"] = d.get("status", "")
                    if d.get("total"):
                        _pull_jobs[name]["total"] = d["total"]
                    if d.get("completed"):
                        _pull_jobs[name]["progress"] = d["completed"]
                    if d.get("error"):
                        _pull_jobs[name]["error"] = d["error"]
                        _pull_jobs[name]["done"] = True
                        log(f"Background pull failed: {name} - {d['error']}", "ERROR")
                        return
        with _pull_jobs_lock:
            _pull_jobs[name]["done"] = True
            _pull_jobs[name]["status"] = "success"
        log(f"Background pull complete: {name}")
    except Exception as e:
        with _pull_jobs_lock:
            _pull_jobs[name]["error"] = str(e)
            _pull_jobs[name]["done"] = True
        log(f"Background pull error: {name} - {e}", "ERROR")

    # Auto-cleanup after 5 minutes
    def _cleanup():
        time.sleep(300)
        with _pull_jobs_lock:
            _pull_jobs.pop(name, None)
    threading.Thread(target=_cleanup, daemon=True).start()

def start_bg_pull(name):
    """Start background pull if not already running."""
    with _pull_jobs_lock:
        job = _pull_jobs.get(name)
        if job and not job["done"]:
            return False, "Already pulling"
    t = threading.Thread(target=_bg_pull_worker, args=(name,), daemon=True)
    t.start()
    return True, "Pull started"

def get_pull_status(name=None):
    with _pull_jobs_lock:
        if name:
            return _pull_jobs.get(name, None)
        return dict(_pull_jobs)

# ─── VPS Sync: fetch desired models from connected VPS ───

_vps_desired_models = []  # [{name, source_vps}]
_vps_desired_lock = threading.Lock()

def sync_desired_models():
    """Fetch model lists from connected VPS instances to know what they need."""
    global _vps_desired_models
    desired = []
    for conn in config.get("vps_connections", []):
        url = conn.get("url", "").rstrip("/")
        if not url:
            continue
        try:
            r = http_requests.get(f"{url}/api/gpu-nodes?action=desired-models", timeout=5)
            if r.ok:
                data = r.json()
                for m in data.get("models", []):
                    desired.append({"name": m, "source": conn.get("name", url)})
        except Exception:
            pass
    with _vps_desired_lock:
        _vps_desired_models = desired

def get_desired_models():
    with _vps_desired_lock:
        return list(_vps_desired_models)

def sync_loop():
    """Background thread: sync desired models from VPS every 60 seconds."""
    while True:
        try:
            sync_desired_models()
        except Exception:
            pass
        time.sleep(60)

def olla_delete(name):
    try:
        r = http_requests.delete(olla_url("/api/delete"), json={"name": name}, timeout=30)
        log(f"Model deleted: {name}")
        return r.ok
    except Exception:
        return False

def olla_unload(name):
    try:
        http_requests.post(olla_url("/api/generate"), json={"model": name, "keep_alive": 0}, timeout=10)
        log(f"Model unloaded: {name}")
        return True
    except Exception:
        return False


# ═══════════════════════════════════════
#  WireGuard
# ═══════════════════════════════════════

def wg_installed():
    return shutil.which("wg") is not None

def wg_status():
    iface = config.get("wireguard", {}).get("interface", "wg0")
    ok, out, _ = run_sudo(f"wg show {iface}")
    return {"active": ok, "output": out if ok else "", "iface": iface}

def wg_install():
    ok, out, err = run_sudo("apt-get update -qq && apt-get install -y -qq wireguard", 120)
    log(f"WireGuard install: {'OK' if ok else 'FAIL'}")
    return ok, (out + "\n" + err).strip()

def wg_genkeys():
    """Generate WireGuard keypair, return (privkey, pubkey)."""
    iface = config.get("wireguard", {}).get("interface", "wg0")
    priv = f"/etc/wireguard/{iface}_private.key"
    pub = f"/etc/wireguard/{iface}_public.key"
    if not os.path.exists(priv):
        run_sudo(f"mkdir -p /etc/wireguard && umask 077 && wg genkey | tee {priv} | wg pubkey > {pub}")
    ok1, pk, _ = run_sudo(f"cat {priv}")
    ok2, pubk, _ = run_sudo(f"cat {pub}")
    return (pk if ok1 else "", pubk if ok2 else "")

def _wg_validate_ip(s):
    """Validate IP or hostname — no newlines, no special WG config chars."""
    s = s.strip()
    if not s or "\n" in s or "\r" in s or " " in s or "=" in s:
        return ""
    if re.match(r'^[\w.\-:]+$', s):  # IP4, IP6, hostname
        return s
    return ""

def _wg_validate_key(s):
    """Validate WG base64 public key (44 chars)."""
    s = s.strip()
    if re.match(r'^[A-Za-z0-9+/]{42,44}={0,2}$', s):
        return s
    return ""

def wg_setup(vps_ip, vps_pubkey):
    vps_ip = _wg_validate_ip(vps_ip)
    vps_pubkey = _wg_validate_key(vps_pubkey)
    if not vps_ip:
        return False, "Некорректный IP/hostname VPS", ""
    if not vps_pubkey:
        return False, "Некорректный WireGuard публичный ключ", ""

    wg = config.get("wireguard", DEFAULT_CONFIG["wireguard"])
    iface = wg.get("interface", "wg0")
    local_ip = wg.get("local_ip", "10.7.0.2")
    peer_ip = wg.get("peer_ip", "10.7.0.1")

    privkey, pubkey = wg_genkeys()
    if not privkey:
        return False, "Не удалось сгенерировать ключи", ""

    conf = f"""[Interface]
Address = {local_ip}/24
PrivateKey = {privkey}

[Peer]
PublicKey = {vps_pubkey}
Endpoint = {vps_ip}:51820
AllowedIPs = {peer_ip}/32
PersistentKeepalive = 25
"""
    # Write conf to temp file, then move with sudo
    try:
        fd, tmp = tempfile.mkstemp(suffix=".conf", prefix="boltby_wg_")
        with os.fdopen(fd, "w") as f:
            f.write(conf)
        ok, _, err = run_sudo(
            f"cp {tmp} /etc/wireguard/{iface}.conf && "
            f"chmod 600 /etc/wireguard/{iface}.conf && "
            f"systemctl enable wg-quick@{iface} 2>/dev/null; "
            f"wg-quick down {iface} 2>/dev/null; wg-quick up {iface}"
        )
        os.unlink(tmp)
    except Exception as e:
        ok, err = False, str(e)
    if ok:
        config.setdefault("wireguard", {})["enabled"] = True
        save_config()
        log(f"WireGuard tunnel to {vps_ip} configured")
    return ok, ("Туннель настроен" if ok else f"Ошибка: {err}"), pubkey

def wg_up():
    iface = config.get("wireguard", {}).get("interface", "wg0")
    ok, _, _ = run_sudo(f"wg-quick up {iface}")
    return ok

def wg_down():
    iface = config.get("wireguard", {}).get("interface", "wg0")
    ok, _, _ = run_sudo(f"wg-quick down {iface}")
    return ok

def wg_test_tunnel():
    """Ping VPS through tunnel."""
    peer_ip = config.get("wireguard", {}).get("peer_ip", "10.7.0.1")
    ok, _, _ = run(f"ping -c 2 -W 3 {peer_ip}", 10)
    return ok


# ═══════════════════════════════════════
#  System
# ═══════════════════════════════════════

_sys_cache = {"info": None, "ts": 0}
_SYS_CACHE_TTL = 30  # 30 seconds

def sys_info():
    now = time.time()
    if _sys_cache["info"] and (now - _sys_cache["ts"]) < _SYS_CACHE_TTL:
        return _sys_cache["info"]

    info = {}
    ok, out, _ = run("lsb_release -ds 2>/dev/null || head -1 /etc/os-release 2>/dev/null")
    info["os"] = out.strip('"') if ok else "Linux"
    ok, out, _ = run("uname -r")
    info["kernel"] = out if ok else ""
    ok, out, _ = run("free -m | awk '/Mem:/{printf \"%s %s\", $2, $3}'")
    if ok and " " in out:
        parts = out.split()
        info["ram_total"] = int(parts[0])
        info["ram_used"] = int(parts[1])
    else:
        info["ram_total"] = info["ram_used"] = 0
    ok, out, _ = run("df -BG --output=avail / | tail -1")
    info["disk_free"] = out.strip() if ok else "?"
    ok, out, _ = run("nproc")
    info["cpus"] = int(out) if ok and out.isdigit() else 0
    info["hostname"] = socket.gethostname()
    info["ip"] = get_primary_ip()
    # CUDA
    ok, out, _ = run("nvidia-smi --query-gpu=driver_version --format=csv,noheader")
    info["nvidia_driver"] = out.strip() if ok else ""
    ok, out, _ = run("nvcc --version 2>/dev/null | grep release | awk '{print $6}'")
    info["cuda"] = out.strip(",") if ok else ""

    _sys_cache["info"] = info
    _sys_cache["ts"] = now
    return info

def check_firewall():
    """Check if Ollama port is open in firewall."""
    port = olla_port()
    ok, out, _ = run(f"ufw status 2>/dev/null | grep {port}")
    if ok and str(port) in out:
        return {"type": "ufw", "open": True}
    ok, out, _ = run(f"firewall-cmd --list-ports 2>/dev/null")
    if ok and f"{port}/tcp" in out:
        return {"type": "firewalld", "open": True}
    # Check if any firewall is active
    ok, _, _ = run("ufw status 2>/dev/null | grep -q 'Status: active'")
    if ok:
        return {"type": "ufw", "open": False}
    ok, _, _ = run("firewall-cmd --state 2>/dev/null | grep -q running")
    if ok:
        return {"type": "firewalld", "open": False}
    return {"type": "none", "open": True}

def open_firewall():
    port = olla_port()
    fw = check_firewall()
    if fw["type"] == "ufw":
        ok, _, _ = run_sudo(f"ufw allow {port}/tcp")
        return ok
    elif fw["type"] == "firewalld":
        ok, _, _ = run_sudo(f"firewall-cmd --permanent --add-port={port}/tcp && firewall-cmd --reload")
        return ok
    return True


# ═══════════════════════════════════════
#  Flask App
# ═══════════════════════════════════════

app = Flask(__name__,
    template_folder=str(Path(__file__).parent / "templates"),
    static_folder=str(Path(__file__).parent / "static"))

@app.route("/")
def index():
    return render_template("index.html", version=APP_VERSION)

# ─── Dashboard ───

@app.route("/api/dashboard")
def api_dashboard():
    with gpu_lock:
        gpu = dict(gpu_cache)
    return jsonify({
        "gpu": gpu,
        "ollama": olla_status(),
        "system": sys_info(),
        "wireguard": {"installed": wg_installed(), **wg_status()},
        "firewall": check_firewall(),
        "config": {
            "port": olla_port(),
            "vps_count": len(config.get("vps_connections", [])),
        },
    })

# ─── Ollama ───

@app.route("/api/ollama/install", methods=["POST"])
def api_olla_install():
    ok, out = olla_install()
    return jsonify({"ok": ok, "output": out})

@app.route("/api/ollama/start", methods=["POST"])
def api_olla_start():
    return jsonify({"ok": olla_start()})

@app.route("/api/ollama/stop", methods=["POST"])
def api_olla_stop():
    return jsonify({"ok": olla_stop()})

@app.route("/api/ollama/restart", methods=["POST"])
def api_olla_restart():
    return jsonify({"ok": olla_restart()})

@app.route("/api/ollama/configure", methods=["POST"])
def api_olla_configure():
    d = request.json
    if "host" in d:
        h = str(d["host"]).strip()
        if not re.match(r'^[\w.\-:]+$', h):
            return jsonify({"ok": False, "error": "Invalid host"}), 400
        config["ollama_host"] = h
    if "port" in d:
        try:
            p = int(d["port"])
            if not (1 <= p <= 65535):
                raise ValueError
            config["ollama_port"] = p
        except (ValueError, TypeError):
            return jsonify({"ok": False, "error": "Invalid port"}), 400
    save_config()
    ok = olla_configure()
    return jsonify({"ok": ok})

# ─── Models ───

@app.route("/api/models")
def api_models():
    return jsonify({"models": olla_models(), "running": olla_running_models()})

@app.route("/api/models/pull", methods=["POST"])
def api_models_pull():
    name = request.json.get("name", "")
    if not name:
        return jsonify({"error": "no name"}), 400
    def gen():
        for chunk in olla_pull(name):
            yield json.dumps(chunk) + "\n"
    return Response(gen(), mimetype="application/x-ndjson")

@app.route("/api/models/delete", methods=["POST"])
def api_models_delete():
    return jsonify({"ok": olla_delete(request.json.get("name", ""))})

@app.route("/api/models/unload", methods=["POST"])
def api_models_unload():
    return jsonify({"ok": olla_unload(request.json.get("name", ""))})

@app.route("/api/models/popular")
def api_models_popular():
    return jsonify(config.get("popular_models", []))

# ─── Remote (VPS calls these) ───

@app.route("/api/remote/pull", methods=["POST"])
def api_remote_pull():
    """VPS triggers model pull on this GPU machine."""
    name = request.json.get("name", "")
    if not name:
        return jsonify({"ok": False, "error": "no name"}), 400
    ok, msg = start_bg_pull(name)
    return jsonify({"ok": ok, "message": msg})

@app.route("/api/remote/pull-status")
def api_remote_pull_status():
    """VPS polls pull progress."""
    name = request.args.get("name", "")
    if name:
        status = get_pull_status(name)
        return jsonify({"ok": True, "job": status})
    return jsonify({"ok": True, "jobs": get_pull_status()})

@app.route("/api/remote/models")
def api_remote_models():
    """VPS fetches installed models list (structured)."""
    return jsonify({"ok": True, "models": olla_models(), "running": olla_running_models()})

# ─── Sync (models desired by VPS) ───

@app.route("/api/sync/desired")
def api_sync_desired():
    """Get models that connected VPS instances want."""
    desired = get_desired_models()
    installed = set(m["name"] for m in olla_models())
    return jsonify({
        "desired": desired,
        "installed": list(installed),
        "missing": [d for d in desired if d["name"] not in installed],
    })

@app.route("/api/sync/refresh", methods=["POST"])
def api_sync_refresh():
    """Force sync with VPS now."""
    sync_desired_models()
    return jsonify({"ok": True, "desired": get_desired_models()})

# ─── GPU ───

@app.route("/api/gpu")
def api_gpu():
    with gpu_lock:
        return jsonify(dict(gpu_cache))

# ─── Network / IPs ───

@app.route("/api/network")
def api_network():
    return jsonify({
        "ips": get_local_ips(),
        "firewall": check_firewall(),
        "port": olla_port(),
    })

@app.route("/api/firewall/open", methods=["POST"])
def api_fw_open():
    return jsonify({"ok": open_firewall()})

# ─── VPS ───

@app.route("/api/vps")
def api_vps_list():
    conns = config.get("vps_connections", [])
    # Quick reachability check (non-blocking, 2s timeout)
    for c in conns:
        url = c.get("url", "").rstrip("/")
        try:
            r = http_requests.get(f"{url}/api/gpu-nodes?action=desired-models", timeout=2)
            c["reachable"] = r.ok
            c["message"] = "Connected" if r.ok else f"HTTP {r.status_code}"
        except Exception as e:
            c["reachable"] = False
            c["message"] = str(e)[:60]
    return jsonify(conns)

@app.route("/api/vps/add", methods=["POST"])
def api_vps_add():
    d = request.json
    url = d.get("url", "").rstrip("/")
    name = d.get("name", url)
    if not url:
        return jsonify({"error": "no url"}), 400
    if not url.startswith(("http://", "https://")):
        return jsonify({"error": "URL must start with http:// or https://"}), 400
    # Test — use desired-models endpoint (known to exist on Boltby)
    reachable, msg = False, ""
    try:
        r = http_requests.get(f"{url}/api/gpu-nodes?action=desired-models", timeout=5)
        reachable = r.ok
        msg = "Connected"
    except Exception as e:
        msg = str(e)
    conn = {"url": url, "name": name, "reachable": reachable, "message": msg,
            "ip": get_primary_ip(), "port": olla_port(), "added": datetime.now().isoformat()}
    conns = [c for c in config.get("vps_connections", []) if c.get("url") != url]
    conns.append(conn)
    config["vps_connections"] = conns
    save_config()
    return jsonify({"ok": True, "connection": conn})

@app.route("/api/vps/remove", methods=["POST"])
def api_vps_remove():
    url = request.json.get("url", "")
    config["vps_connections"] = [c for c in config.get("vps_connections", []) if c.get("url") != url]
    save_config()
    return jsonify({"ok": True})

@app.route("/api/vps/test", methods=["POST"])
def api_vps_test():
    url = request.json.get("url", "").rstrip("/")
    if not url.startswith(("http://", "https://")):
        return jsonify({"ok": False, "msg": "URL must start with http:// or https://"}), 400
    try:
        r = http_requests.get(f"{url}/api/gpu-nodes?action=desired-models", timeout=5)
        return jsonify({"ok": r.ok, "msg": "OK"})
    except Exception as e:
        return jsonify({"ok": False, "msg": str(e)})

# ─── WireGuard ───

@app.route("/api/wg/status")
def api_wg_stat():
    s = wg_status()
    _, pubkey = wg_genkeys() if wg_installed() else ("", "")
    return jsonify({
        "installed": wg_installed(),
        **s,
        "pubkey": pubkey,
        "tunnel_ok": wg_test_tunnel() if s["active"] else False,
        "config": config.get("wireguard", {}),
    })

@app.route("/api/wg/install", methods=["POST"])
def api_wg_inst():
    ok, out = wg_install()
    return jsonify({"ok": ok, "output": out})

@app.route("/api/wg/setup", methods=["POST"])
def api_wg_setup():
    d = request.json
    ok, msg, pubkey = wg_setup(d.get("vps_ip", ""), d.get("vps_pubkey", ""))
    return jsonify({"ok": ok, "message": msg, "pubkey": pubkey})

@app.route("/api/wg/up", methods=["POST"])
def api_wg_up():
    return jsonify({"ok": wg_up()})

@app.route("/api/wg/down", methods=["POST"])
def api_wg_down():
    return jsonify({"ok": wg_down()})

# ─── Settings ───

@app.route("/api/settings")
def api_settings_get():
    return jsonify(config)

@app.route("/api/settings", methods=["POST"])
def api_settings_save():
    d = request.json
    # Validate ollama_host (IP or hostname, no newlines/special chars)
    if "ollama_host" in d:
        h = str(d["ollama_host"]).strip()
        if not re.match(r'^[\w.\-:]+$', h):
            return jsonify({"ok": False, "error": "Invalid ollama_host"}), 400
        config["ollama_host"] = h
    if "ollama_port" in d:
        try:
            p = int(d["ollama_port"])
            if not (1 <= p <= 65535):
                raise ValueError
            config["ollama_port"] = p
        except (ValueError, TypeError):
            return jsonify({"ok": False, "error": "Invalid ollama_port"}), 400
    for k in ("autostart_ollama", "autostart_agent"):
        if k in d:
            config[k] = d[k]
    if "wireguard" in d:
        wg_update = d["wireguard"]
        # Validate wireguard fields to prevent command injection
        if "interface" in wg_update:
            if not re.match(r'^[a-zA-Z0-9_-]{1,15}$', str(wg_update["interface"])):
                return jsonify({"ok": False, "error": "Invalid interface name"}), 400
        for ip_key in ("local_ip", "peer_ip"):
            if ip_key in wg_update:
                if not _wg_validate_ip(str(wg_update[ip_key])):
                    return jsonify({"ok": False, "error": f"Invalid {ip_key}"}), 400
        config["wireguard"] = {**config.get("wireguard", {}), **wg_update}
    save_config()
    return jsonify({"ok": True})

# ─── Logs ───

@app.route("/api/logs")
def api_logs():
    return jsonify({"lines": log_buffer[-200:]})

# ─── Autostart ───

@app.route("/api/autostart/enable", methods=["POST"])
def api_autostart_on():
    ok = setup_autostart(True)
    config["autostart_agent"] = True
    save_config()
    return jsonify({"ok": ok})

@app.route("/api/autostart/disable", methods=["POST"])
def api_autostart_off():
    setup_autostart(False)
    config["autostart_agent"] = False
    save_config()
    return jsonify({"ok": True})

def setup_autostart(enable):
    """Setup XDG autostart for current user."""
    autostart_dir = Path.home() / ".config" / "autostart"
    autostart_file = autostart_dir / "boltby-gpu.desktop"
    if enable:
        autostart_dir.mkdir(parents=True, exist_ok=True)
        exe = Path(__file__).resolve()
        autostart_file.write_text(f"""[Desktop Entry]
Type=Application
Name=Boltby GPU Agent
Exec={sys.executable} {exe} --background
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Comment=GPU node manager for Boltby
""")
        return True
    else:
        autostart_file.unlink(missing_ok=True)
        return True


# ═══════════════════════════════════════
#  Main
# ═══════════════════════════════════════

def main():
    load_config()
    log(f"Boltby GPU Agent v{APP_VERSION}")
    log(f"IP: {get_primary_ip()}")

    # GPU monitor thread
    threading.Thread(target=gpu_monitor_thread, daemon=True).start()

    # VPS sync thread (fetches desired models from connected VPS every 60s)
    threading.Thread(target=sync_loop, daemon=True).start()

    # Auto-start Ollama
    if config.get("autostart_ollama") and olla_installed() and not olla_running():
        log("Auto-starting Ollama...")
        olla_start()

    background = "--background" in sys.argv or "--no-browser" in sys.argv

    # Try native window (pywebview)
    if not background:
        try:
            import webview
            log("Opening native window (pywebview)")

            def start_flask():
                app.run(host="127.0.0.1", port=APP_PORT, debug=False, use_reloader=False)

            flask_thread = threading.Thread(target=start_flask, daemon=True)
            flask_thread.start()
            time.sleep(0.5)

            window = webview.create_window(
                "Boltby GPU Agent",
                f"http://127.0.0.1:{APP_PORT}",
                width=1100, height=750,
                min_size=(800, 500),
                resizable=True,
                text_select=True,
            )
            webview.start(gui="gtk")  # or "qt" on KDE
            return
        except ImportError:
            log("pywebview not installed, falling back to browser mode")
        except Exception as e:
            log(f"pywebview failed: {e}, falling back to browser")

    # Fallback: open in browser
    if not background:
        import webbrowser
        def open_later():
            time.sleep(1)
            webbrowser.open(f"http://localhost:{APP_PORT}")
        threading.Thread(target=open_later, daemon=True).start()

    log(f"Web UI: http://localhost:{APP_PORT}")
    app.run(host="127.0.0.1", port=APP_PORT, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
