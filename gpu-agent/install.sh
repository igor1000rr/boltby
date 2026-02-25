#!/bin/bash
# Don't use set -e: we handle errors manually to avoid aborting on optional steps

# ══════════════════════════════════════════════════
#  Boltby GPU Agent — Установщик
#
#  Устанавливает десктоп-приложение для управления
#  GPU нодой: Ollama, модели, WireGuard, VPS — всё
#  из GUI без консоли.
#
#  Запуск:
#    sudo ./install.sh
# ══════════════════════════════════════════════════

DIR="/opt/boltby-gpu"
SVC="boltby-gpu"
PORT=7860

C='\033[0;36m'; G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; N='\033[0m'

echo ""
echo -e "${C}★═══════════════════════════════════════★${N}"
echo -e "${C}  ⚡ Boltby GPU Agent — Установка${N}"
echo -e "${C}★═══════════════════════════════════════★${N}"
echo ""

# ─── Root check ───
if [ "$(id -u)" -ne 0 ]; then
  echo -e "${R}❌ Запусти от root: sudo $0${N}"
  exit 1
fi

USR="${SUDO_USER:-$USER}"
UHOME=$(eval echo ~${USR})

echo -e "👤 Пользователь: ${G}${USR}${N}"
echo -e "📂 Домашняя:     ${UHOME}"
echo ""

# ─── 1. Python + pip + зависимости ───
echo "📦 Зависимости..."

apt-get update -qq 2>/dev/null || true

command -v python3 &>/dev/null || apt-get install -y -qq python3 python3-pip 2>/dev/null

python3 -m pip install --quiet --break-system-packages flask requests 2>/dev/null || \
python3 -m pip install --quiet flask requests 2>/dev/null

# Нативное окно (опционально)
python3 -m pip install --quiet --break-system-packages pywebview 2>/dev/null || true
# GTK dependencies for pywebview
apt-get install -y -qq python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.1 2>/dev/null || true

echo -e "  ${G}✅ Python + Flask${N}"

# GPU
if command -v nvidia-smi &>/dev/null; then
  GPU=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
  VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
  echo -e "  ${G}✅ GPU: ${GPU} (${VRAM}MB VRAM)${N}"
else
  echo -e "  ${Y}⚠️  nvidia-smi не найден${N}"
fi

# ─── 2. Ollama ───
if ! command -v ollama &>/dev/null; then
  echo ""
  read -p "🦙 Установить Ollama? [Y/n]: " INST
  INST=${INST:-Y}
  if [[ "$INST" =~ ^[Yy] ]]; then
    echo "📦 Установка Ollama..."
    curl -fsSL https://ollama.ai/install.sh | sh
    mkdir -p /etc/systemd/system/ollama.service.d
    cat > /etc/systemd/system/ollama.service.d/boltby.conf << 'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_ORIGINS=*"
EOF
    systemctl daemon-reload
    systemctl enable ollama
    systemctl start ollama
    echo -e "  ${G}✅ Ollama установлен и запущен${N}"
  fi
else
  VER=$(ollama --version 2>/dev/null | sed 's/ollama version is //')
  echo -e "  ${G}✅ Ollama v${VER}${N}"
  # Ensure external access
  mkdir -p /etc/systemd/system/ollama.service.d
  if ! grep -q "OLLAMA_HOST=0.0.0.0" /etc/systemd/system/ollama.service.d/boltby.conf 2>/dev/null; then
    cat > /etc/systemd/system/ollama.service.d/boltby.conf << 'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_ORIGINS=*"
EOF
    systemctl daemon-reload
    systemctl restart ollama
    echo -e "  ${G}✅ Ollama: внешний доступ включён${N}"
  fi
fi

# ─── 3. Copy files ───
echo ""
echo "📂 Установка в ${DIR}..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
mkdir -p "${DIR}"

# Check if files exist in script directory
if [ -f "${SCRIPT_DIR}/boltby-gpu.py" ]; then
  cp "${SCRIPT_DIR}/boltby-gpu.py" "${DIR}/"
  cp -r "${SCRIPT_DIR}/templates" "${DIR}/"
  [ -d "${SCRIPT_DIR}/static" ] && cp -r "${SCRIPT_DIR}/static" "${DIR}/"
elif [ -f "./boltby-gpu.py" ]; then
  # Fallback: try current directory
  cp "./boltby-gpu.py" "${DIR}/"
  cp -r "./templates" "${DIR}/"
  [ -d "./static" ] && cp -r "./static" "${DIR}/"
else
  echo -e "${R}❌ boltby-gpu.py не найден!${N}"
  echo "   Запусти install.sh из папки gpu-agent/ или положи файлы рядом."
  exit 1
fi

chmod +x "${DIR}/boltby-gpu.py"

# Config directory
mkdir -p "${UHOME}/.config/boltby-gpu"
chown -R ${USR}:${USR} "${UHOME}/.config/boltby-gpu"

echo -e "  ${G}✅ Файлы установлены${N}"

# ─── 4. Systemd service ───
echo "🔧 Сервис..."

cat > "/etc/systemd/system/${SVC}.service" << SVCEOF
[Unit]
Description=Boltby GPU Agent
After=network.target ollama.service
Wants=ollama.service

[Service]
Type=simple
User=${USR}
WorkingDirectory=${DIR}
ExecStart=/usr/bin/python3 ${DIR}/boltby-gpu.py --background
Restart=on-failure
RestartSec=5
Environment=HOME=${UHOME}
Environment=DISPLAY=:0

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable ${SVC}
echo -e "  ${G}✅ Сервис ${SVC} создан${N}"

# ─── 5. Desktop shortcuts ───
echo "🖥️  Ярлыки..."

# Application menu
cat > /usr/share/applications/boltby-gpu.desktop << DSKEOF
[Desktop Entry]
Type=Application
Name=Boltby GPU Agent
GenericName=GPU Node Manager
Comment=Управление GPU нодой для Boltby
Exec=/usr/bin/python3 ${DIR}/boltby-gpu.py
Icon=preferences-system
Terminal=false
Categories=Development;System;
Keywords=gpu;ollama;ai;llm;
StartupNotify=true
DSKEOF

# Desktop shortcut
for DDIR in "${UHOME}/Desktop" "${UHOME}/Рабочий стол"; do
  if [ -d "$DDIR" ]; then
    cp /usr/share/applications/boltby-gpu.desktop "${DDIR}/"
    chown ${USR}:${USR} "${DDIR}/boltby-gpu.desktop"
    chmod +x "${DDIR}/boltby-gpu.desktop"
    sudo -u ${USR} gio set "${DDIR}/boltby-gpu.desktop" metadata::trusted true 2>/dev/null || true
    echo -e "  ${G}✅ Ярлык на рабочем столе${N}"
  fi
done

# Autostart
mkdir -p "${UHOME}/.config/autostart"
cat > "${UHOME}/.config/autostart/boltby-gpu.desktop" << ASEOF
[Desktop Entry]
Type=Application
Name=Boltby GPU Agent
Exec=/usr/bin/python3 ${DIR}/boltby-gpu.py --background
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Comment=GPU node manager
ASEOF
chown -R ${USR}:${USR} "${UHOME}/.config/autostart"
echo -e "  ${G}✅ Автозапуск настроен${N}"

# ─── 6. CLI shortcut ───
cat > /usr/local/bin/boltby-gpu << 'CLIEOF'
#!/bin/bash
case "$1" in
  start)   sudo systemctl start boltby-gpu && echo "✅ Started" ;;
  stop)    sudo systemctl stop boltby-gpu && echo "✅ Stopped" ;;
  restart) sudo systemctl restart boltby-gpu && echo "✅ Restarted" ;;
  status)  systemctl status boltby-gpu ;;
  open)    xdg-open http://localhost:7860 2>/dev/null ;;
  log)     journalctl -u boltby-gpu -f ;;
  *)
    echo "Boltby GPU Agent"
    echo "  boltby-gpu start|stop|restart|status|open|log"
    ;;
esac
CLIEOF
chmod +x /usr/local/bin/boltby-gpu
echo -e "  ${G}✅ CLI: boltby-gpu start|stop|open${N}"

# ─── 7. Start ───
echo ""
echo "🚀 Запуск..."
systemctl start ${SVC}
sleep 2

IP=$(hostname -I | awk '{print $1}')

if systemctl is-active --quiet ${SVC}; then
  echo ""
  echo -e "${C}★═══════════════════════════════════════★${N}"
  echo -e "  ${G}✅ Boltby GPU Agent установлен!${N}"
  echo ""
  echo -e "  🖥️  ${C}Приложение:${N}  Найди «Boltby GPU Agent» в меню"
  echo -e "  🌐 ${C}Веб UI:${N}      http://localhost:${PORT}"
  echo -e "  📡 ${C}IP машины:${N}   ${IP}"
  echo ""
  echo -e "  📋 ${C}CLI:${N}  boltby-gpu start|stop|open|status"
  echo -e "${C}★═══════════════════════════════════════★${N}"

  # Open if display
  if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
    sudo -u ${USR} xdg-open "http://localhost:${PORT}" 2>/dev/null &
  fi
else
  echo -e "${R}❌ Не удалось запустить. Смотри: journalctl -u ${SVC} -n 30${N}"
fi
