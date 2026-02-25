#!/bin/bash
set -e

# ══════════════════════════════════════════════════════════════
#  WireGuard туннель: VPS ↔ GPU PC (Ollama)
#
#  Схема:
#    VPS (45.87.219.104)          GPU PC (твой Linux + 5090)
#    ┌─────────────────┐          ┌──────────────────────┐
#    │  Boltby UI :80   │          │  Ollama :11434       │
#    │  Appwrite :8080  │◄────────►│  (RTX 5090)          │
#    │  wg0: 10.7.0.1  │ WireGuard│  wg0: 10.7.0.2      │
#    └─────────────────┘  :51820  └──────────────────────┘
#
#  После настройки:
#    VPS видит Ollama по адресу 10.7.0.2:11434
#    Boltby .env: OLLAMA_API_BASE_URL=http://10.7.0.2:11434
#
#  Запуск:
#    На VPS:    ./tunnel-setup.sh vps
#    На GPU PC: ./tunnel-setup.sh gpu
# ══════════════════════════════════════════════════════════════

VPS_IP="45.87.219.104"
VPS_WG_IP="10.7.0.1"
GPU_WG_IP="10.7.0.2"
WG_PORT="51820"
WG_IFACE="wg0"

ROLE="${1:-}"

if [ -z "$ROLE" ]; then
  echo "Usage: ./tunnel-setup.sh [vps|gpu]"
  echo ""
  echo "  vps  — запустить на VPS сервере"
  echo "  gpu  — запустить на GPU PC (Linux с 5090)"
  exit 1
fi

# ─── Установка WireGuard ───
install_wireguard() {
  if command -v wg &> /dev/null; then
    echo "✅ WireGuard уже установлен"
    return
  fi
  
  echo "📦 Установка WireGuard..."
  
  if [ -f /etc/debian_version ]; then
    apt-get update -qq && apt-get install -y -qq wireguard
  elif [ -f /etc/redhat-release ]; then
    yum install -y epel-release && yum install -y wireguard-tools
  elif [ -f /etc/arch-release ]; then
    pacman -S --noconfirm wireguard-tools
  else
    echo "❌ Неизвестный дистрибутив. Установи WireGuard вручную."
    exit 1
  fi
  
  echo "✅ WireGuard установлен"
}

# ─── Генерация ключей ───
generate_keys() {
  local name="$1"
  
  if [ -f "/etc/wireguard/${name}_private.key" ]; then
    echo "✅ Ключи ${name} уже существуют"
    return
  fi
  
  umask 077
  wg genkey | tee "/etc/wireguard/${name}_private.key" | wg pubkey > "/etc/wireguard/${name}_public.key"
  chmod 600 /etc/wireguard/${name}_private.key
  
  echo "✅ Ключи ${name} сгенерированы"
  echo "   Public key: $(cat /etc/wireguard/${name}_public.key)"
}

# ══════════════════════════════════════
#  НАСТРОЙКА VPS
# ══════════════════════════════════════
setup_vps() {
  echo ""
  echo "★═══════════════════════════════════════★"
  echo "   Настройка WireGuard на VPS"
  echo "★═══════════════════════════════════════★"
  echo ""
  
  install_wireguard
  generate_keys "vps"
  
  VPS_PRIVKEY=$(cat /etc/wireguard/vps_private.key)
  VPS_PUBKEY=$(cat /etc/wireguard/vps_public.key)
  
  # Проверяем есть ли уже ключ GPU PC
  if [ -f "/etc/wireguard/gpu_public.key" ]; then
    GPU_PUBKEY=$(cat /etc/wireguard/gpu_public.key)
  else
    echo ""
    echo "⚠️  Нужен public key GPU PC."
    echo "   Запусти на GPU PC: ./tunnel-setup.sh gpu"
    echo "   Затем вставь его public key сюда:"
    read -p "   GPU Public Key: " GPU_PUBKEY
    echo "$GPU_PUBKEY" > /etc/wireguard/gpu_public.key
  fi
  
  # Создаём конфиг
  cat > "/etc/wireguard/${WG_IFACE}.conf" << WGCONF
[Interface]
Address = ${VPS_WG_IP}/24
ListenPort = ${WG_PORT}
PrivateKey = ${VPS_PRIVKEY}

[Peer]
# GPU PC
PublicKey = ${GPU_PUBKEY}
AllowedIPs = ${GPU_WG_IP}/32
PersistentKeepalive = 25
WGCONF
  
  chmod 600 "/etc/wireguard/${WG_IFACE}.conf"
  
  # Firewall
  ufw allow ${WG_PORT}/udp 2>/dev/null || true
  
  # Включаем
  systemctl enable wg-quick@${WG_IFACE}
  systemctl restart wg-quick@${WG_IFACE} 2>/dev/null || wg-quick up ${WG_IFACE}
  
  # Обновляем Boltby .env
  BOLTBY_ENV="/opt/boltby/.env"
  if [ -f "$BOLTBY_ENV" ]; then
    if grep -q "^OLLAMA_API_BASE_URL=" "$BOLTBY_ENV"; then
      sed -i "s|^OLLAMA_API_BASE_URL=.*|OLLAMA_API_BASE_URL=http://${GPU_WG_IP}:11434|" "$BOLTBY_ENV"
    else
      echo "OLLAMA_API_BASE_URL=http://${GPU_WG_IP}:11434" >> "$BOLTBY_ENV"
    fi
    echo "✅ OLLAMA_API_BASE_URL обновлён в ${BOLTBY_ENV}"
  fi
  
  echo ""
  echo "★═══════════════════════════════════════★"
  echo "  ✅ VPS настроен"
  echo ""
  echo "  VPS WireGuard IP:  ${VPS_WG_IP}"
  echo "  VPS Public Key:    ${VPS_PUBKEY}"
  echo "  Ожидает GPU PC на: ${GPU_WG_IP}"
  echo ""
  echo "  📋 Этот public key нужен для GPU PC:"
  echo "  ${VPS_PUBKEY}"
  echo "★═══════════════════════════════════════★"
}

# ══════════════════════════════════════
#  НАСТРОЙКА GPU PC
# ══════════════════════════════════════
setup_gpu() {
  echo ""
  echo "★═══════════════════════════════════════★"
  echo "   Настройка WireGuard на GPU PC"
  echo "★═══════════════════════════════════════★"
  echo ""
  
  install_wireguard
  generate_keys "gpu"
  
  GPU_PRIVKEY=$(cat /etc/wireguard/gpu_private.key)
  GPU_PUBKEY=$(cat /etc/wireguard/gpu_public.key)
  
  # Получаем VPS public key
  if [ -f "/etc/wireguard/vps_public.key" ]; then
    VPS_PUBKEY=$(cat /etc/wireguard/vps_public.key)
  else
    echo ""
    echo "⚠️  Нужен public key VPS."
    echo "   Запусти на VPS: ./tunnel-setup.sh vps"
    echo "   Затем вставь его public key сюда:"
    read -p "   VPS Public Key: " VPS_PUBKEY
    echo "$VPS_PUBKEY" > /etc/wireguard/vps_public.key
  fi
  
  # Создаём конфиг
  cat > "/etc/wireguard/${WG_IFACE}.conf" << WGCONF
[Interface]
Address = ${GPU_WG_IP}/24
PrivateKey = ${GPU_PRIVKEY}

[Peer]
# VPS
PublicKey = ${VPS_PUBKEY}
Endpoint = ${VPS_IP}:${WG_PORT}
AllowedIPs = ${VPS_WG_IP}/32
PersistentKeepalive = 25
WGCONF
  
  chmod 600 "/etc/wireguard/${WG_IFACE}.conf"
  
  # Включаем
  systemctl enable wg-quick@${WG_IFACE}
  systemctl restart wg-quick@${WG_IFACE} 2>/dev/null || wg-quick up ${WG_IFACE}
  
  # ─── Настройка Ollama ───
  echo ""
  echo "🤖 Настройка Ollama..."
  
  if ! command -v ollama &> /dev/null; then
    echo "📦 Установка Ollama..."
    curl -fsSL https://ollama.ai/install.sh | sh
  fi
  
  # Ollama должен слушать на WireGuard интерфейсе
  mkdir -p /etc/systemd/system/ollama.service.d
  cat > /etc/systemd/system/ollama.service.d/override.conf << OVERRIDE
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_ORIGINS=*"
OVERRIDE
  
  systemctl daemon-reload
  systemctl enable ollama
  systemctl restart ollama
  
  echo ""
  echo "★═══════════════════════════════════════★"
  echo "  ✅ GPU PC настроен"
  echo ""
  echo "  GPU WireGuard IP:  ${GPU_WG_IP}"
  echo "  GPU Public Key:    ${GPU_PUBKEY}"
  echo "  Ollama слушает на: 0.0.0.0:11434"
  echo ""
  echo "  📋 Этот public key нужен для VPS:"
  echo "  ${GPU_PUBKEY}"
  echo ""
  echo "  🧪 Проверка (на VPS после настройки):"
  echo "    ping ${GPU_WG_IP}"
  echo "    curl http://${GPU_WG_IP}:11434/api/tags"
  echo ""
  echo "  📥 Скачать модель:"
  echo "    ollama pull qwen2.5-coder:32b"
  echo "    ollama pull deepseek-coder-v2:16b"
  echo "★═══════════════════════════════════════★"
}

# ═══ Запуск ═══
case "$ROLE" in
  vps)  setup_vps ;;
  gpu)  setup_gpu ;;
  *)    echo "❌ Неизвестная роль: $ROLE. Используй: vps | gpu"; exit 1 ;;
esac
