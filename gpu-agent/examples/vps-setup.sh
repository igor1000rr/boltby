#!/bin/bash
# ══════════════════════════════════════════════════
#  Быстрая настройка VPS (WireGuard сервер)
#
#  Запуск на VPS:
#    curl -fsSL <url>/vps-setup.sh | sudo bash
#
#  Или вручную: sudo bash vps-setup.sh
# ══════════════════════════════════════════════════

set +e

C='\033[0;36m'; G='\033[0;32m'; R='\033[0;31m'; N='\033[0m'

echo ""
echo "★═══════════════════════════════════════════★"
echo "   🔒 Boltby VPS — WireGuard Setup"
echo "★═══════════════════════════════════════════★"
echo ""

# ─── 1. Install WireGuard ───
echo -e "${C}[1/4]${N} Установка WireGuard..."

if command -v wg &>/dev/null; then
  echo -e "  ${G}✅ WireGuard уже установлен${N}"
else
  apt-get update -qq 2>/dev/null || true
  apt-get install -y -qq wireguard 2>/dev/null
  if command -v wg &>/dev/null; then
    echo -e "  ${G}✅ WireGuard установлен${N}"
  else
    echo -e "  ${R}❌ Не удалось установить WireGuard${N}"
    exit 1
  fi
fi

# ─── 2. Generate keys ───
echo -e "${C}[2/4]${N} Генерация ключей..."

if [ -f /etc/wireguard/server_private.key ]; then
  echo -e "  ${G}✅ Ключи уже есть${N}"
else
  wg genkey | tee /etc/wireguard/server_private.key | wg pubkey > /etc/wireguard/server_public.key
  chmod 600 /etc/wireguard/server_private.key
  echo -e "  ${G}✅ Ключи сгенерированы${N}"
fi

PRIVATE_KEY=$(cat /etc/wireguard/server_private.key)
PUBLIC_KEY=$(cat /etc/wireguard/server_public.key)

# ─── 3. Create config ───
echo -e "${C}[3/4]${N} Создание конфигурации..."

if [ -f /etc/wireguard/wg0.conf ]; then
  echo -e "  ⚠️  wg0.conf уже существует, пропускаю"
else
  cat > /etc/wireguard/wg0.conf << EOF
[Interface]
Address = 10.7.0.1/24
ListenPort = 51820
PrivateKey = ${PRIVATE_KEY}

# GPU Node — добавь после настройки агента:
# [Peer]
# PublicKey = <GPU_PUBLIC_KEY>
# AllowedIPs = 10.7.0.2/32
EOF
  chmod 600 /etc/wireguard/wg0.conf
  echo -e "  ${G}✅ Конфигурация создана${N}"
fi

# ─── 4. Start & firewall ───
echo -e "${C}[4/4]${N} Запуск..."

systemctl enable wg-quick@wg0 2>/dev/null
wg-quick down wg0 2>/dev/null
wg-quick up wg0

# Firewall
if command -v ufw &>/dev/null; then
  ufw allow 51820/udp 2>/dev/null
  echo -e "  ${G}✅ Порт 51820/udp открыт (ufw)${N}"
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port=51820/udp 2>/dev/null
  firewall-cmd --reload 2>/dev/null
  echo -e "  ${G}✅ Порт 51820/udp открыт (firewalld)${N}"
fi

# ─── Done ───
VPS_IP=$(curl -sf --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo "★═══════════════════════════════════════════★"
echo -e "  ${G}✅ WireGuard сервер настроен!${N}"
echo "★═══════════════════════════════════════════★"
echo ""
echo "  Данные для GPU Agent:"
echo -e "  ${C}VPS IP:${N}      ${VPS_IP}"
echo -e "  ${C}Public Key:${N}  ${PUBLIC_KEY}"
echo -e "  ${C}Endpoint:${N}    ${VPS_IP}:51820"
echo ""
echo "  Следующий шаг:"
echo "  1. На GPU машине → Agent UI → Сеть → WireGuard"
echo "  2. Введи VPS IP и Public Key выше"
echo "  3. Нажми '🔧 Настроить'"
echo "  4. Скопируй GPU Public Key и добавь в /etc/wireguard/wg0.conf:"
echo ""
echo "     [Peer]"
echo "     PublicKey = <GPU_PUBLIC_KEY>"
echo "     AllowedIPs = 10.7.0.2/32"
echo ""
echo "  5. Перезапусти: wg-quick down wg0 && wg-quick up wg0"
echo "  6. Проверь: ping 10.7.0.2"
echo ""
