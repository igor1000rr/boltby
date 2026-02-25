import { type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';

declare global {
  // eslint-disable-next-line no-var
  var __pendingGpuNodes: any[] | undefined;
}

/**
 * GPU Setup API
 *
 * GET  /api/gpu-setup?token=xxx          → serves bash installer script
 * POST /api/gpu-setup  { token, host, port, name, gpu } → auto-register node
 */

interface SetupToken {
  uid: string;
  name: string;
  url: string;
  ts: number;
}

function decodeToken(token: string): SetupToken | null {
  try {
    const json = atob(token);
    const data = JSON.parse(json);

    // Token valid for 24 hours
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) {
      return null;
    }

    if (!data.uid || !data.url) {
      return null;
    }

    return data as SetupToken;
  } catch {
    return null;
  }
}

// ─── GET: Serve installer script ───

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';

  const tokenData = decodeToken(token);

  if (!tokenData) {
    return new Response(
      '# ❌ Невалидный или просроченный токен.\n# Сгенерируй новую команду в Boltby → Settings → GPU Nodes\nexit 1\n',
      {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      },
    );
  }

  const boltbyUrl = tokenData.url.replace(/\/$/, '');

  const script = `#!/bin/bash
# Boltby GPU Node Setup - errors handled manually, no set -e

# ══════════════════════════════════════════════════════════════
#  Boltby GPU Node Setup
#  Автоматическая настройка машины как GPU ноды для Boltby
# ══════════════════════════════════════════════════════════════

BOLTBY_URL="${boltbyUrl}"
TOKEN="${token}"
PORT="11434"

echo ""
echo "★═══════════════════════════════════════════★"
echo "   🚀 Boltby GPU Node Setup"
echo "★═══════════════════════════════════════════★"
echo ""

# ─── 1. Определение ОС ───
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_NAME="$NAME $VERSION_ID"
else
  OS_NAME="Unknown"
fi
echo "📋 Система: $OS_NAME"
echo "📋 Ядро:    $(uname -r)"

# ─── 2. Определение GPU ───
GPU_INFO="no-gpu"
GPU_VRAM=""

if command -v nvidia-smi &> /dev/null; then
  GPU_INFO=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "nvidia")
  GPU_VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "")
  echo "🎮 GPU: $GPU_INFO (\${GPU_VRAM}MB VRAM)"
elif command -v rocm-smi &> /dev/null; then
  GPU_INFO="AMD ROCm"
  echo "🎮 GPU: AMD (ROCm)"
else
  echo "⚠️  GPU не обнаружен (nvidia-smi не найден)"
  echo "   Ollama будет работать на CPU"
fi

# ─── 3. Установка Ollama ───
if command -v ollama &> /dev/null; then
  OLLAMA_VER=$(ollama --version 2>/dev/null || echo "unknown")
  echo "✅ Ollama уже установлен: $OLLAMA_VER"
else
  echo "📦 Установка Ollama..."
  curl -fsSL https://ollama.ai/install.sh | sh
  echo "✅ Ollama установлен"
fi

# ─── 4. Настройка Ollama: слушать на всех интерфейсах ───
echo "⚙️  Настройка Ollama (OLLAMA_HOST=0.0.0.0)..."

# Systemd override
if [ -d /etc/systemd/system ]; then
  mkdir -p /etc/systemd/system/ollama.service.d
  cat > /etc/systemd/system/ollama.service.d/boltby.conf << 'OVERRIDE'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_ORIGINS=*"
OVERRIDE
  systemctl daemon-reload
  systemctl enable ollama 2>/dev/null || true
  systemctl restart ollama
  echo "✅ Ollama настроен и запущен (systemd)"
else
  # Fallback: environment file (avoid duplicates)
  grep -q 'OLLAMA_HOST=0.0.0.0' /etc/environment 2>/dev/null || echo 'OLLAMA_HOST=0.0.0.0:11434' >> /etc/environment
  grep -q 'OLLAMA_ORIGINS' /etc/environment 2>/dev/null || echo 'OLLAMA_ORIGINS=*' >> /etc/environment
  # Try to restart
  if pgrep ollama > /dev/null; then
    pkill ollama && sleep 2
  fi
  OLLAMA_HOST=0.0.0.0:11434 OLLAMA_ORIGINS=* nohup ollama serve > /var/log/ollama.log 2>&1 &
  echo "✅ Ollama настроен и запущен (manual)"
fi

# Ждём пока Ollama поднимется
echo -n "   Ожидание запуска Ollama"
for i in $(seq 1 15); do
  if curl -sf http://127.0.0.1:$PORT/api/tags > /dev/null 2>&1; then
    echo " ✅"
    break
  fi
  echo -n "."
  sleep 1
done

# Проверка
if ! curl -sf http://127.0.0.1:$PORT/api/tags > /dev/null 2>&1; then
  echo ""
  echo "❌ Ollama не отвечает на порту $PORT"
  echo "   Попробуй: systemctl status ollama"
  exit 1
fi

# ─── 5. Подсчёт моделей ───
MODEL_COUNT=$(curl -sf http://127.0.0.1:$PORT/api/tags 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('models',[])))" 2>/dev/null || echo "0")
echo "📦 Моделей загружено: $MODEL_COUNT"

# ─── 6. Определение IP адреса ───
echo ""
echo "🌐 Определение IP адресов..."

# Собираем все не-loopback IPv4
ALL_IPS=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || hostname -I 2>/dev/null | tr ' ' '\\n' | grep -v '^$')

# Внешний IP
EXTERNAL_IP=$(curl -sf --max-time 5 https://ifconfig.me 2>/dev/null || curl -sf --max-time 5 https://icanhazip.com 2>/dev/null || echo "")

# WireGuard IP
WG_IP=$(ip -4 -o addr show dev wg0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || echo "")

# Приватный IP (не WG)
PRIVATE_IP=$(echo "$ALL_IPS" | grep -v "^$WG_IP$" | head -1 || echo "")

echo ""
echo "   Найденные адреса:"
IDX=0
declare -a IP_LIST

if [ -n "$WG_IP" ]; then
  IDX=$((IDX+1))
  IP_LIST[$IDX]="$WG_IP"
  echo "   [$IDX] $WG_IP (WireGuard) ← рекомендуется"
fi

if [ -n "$EXTERNAL_IP" ]; then
  IDX=$((IDX+1))
  IP_LIST[$IDX]="$EXTERNAL_IP"
  echo "   [$IDX] $EXTERNAL_IP (внешний IP)"
fi

if [ -n "$PRIVATE_IP" ]; then
  IDX=$((IDX+1))
  IP_LIST[$IDX]="$PRIVATE_IP"
  echo "   [$IDX] $PRIVATE_IP (локальная сеть)"
fi

# Выбираем дефолт: WG > External > Private
if [ -n "$WG_IP" ]; then
  DEFAULT_IP="$WG_IP"
elif [ -n "$EXTERNAL_IP" ]; then
  DEFAULT_IP="$EXTERNAL_IP"
elif [ -n "$PRIVATE_IP" ]; then
  DEFAULT_IP="$PRIVATE_IP"
else
  DEFAULT_IP="127.0.0.1"
fi

echo ""
read -p "   Какой IP использовать? [$DEFAULT_IP]: " CHOSEN_IP
CHOSEN_IP="\${CHOSEN_IP:-$DEFAULT_IP}"

# ─── 7. Имя ноды ───
DEFAULT_NAME="$(hostname)"
if [ -n "$GPU_INFO" ] && [ "$GPU_INFO" != "no-gpu" ]; then
  DEFAULT_NAME="$(hostname) ($GPU_INFO)"
fi
# Обрезаем до 100 символов
DEFAULT_NAME=$(echo "$DEFAULT_NAME" | cut -c1-100)

read -p "   Название ноды? [$DEFAULT_NAME]: " NODE_NAME
NODE_NAME="\${NODE_NAME:-$DEFAULT_NAME}"

# ─── 8. Видимость ───
read -p "   Сделать ноду доступной другим пользователям? [Y/n]: " IS_PUBLIC
IS_PUBLIC="\${IS_PUBLIC:-Y}"
case "$IS_PUBLIC" in
  [nN]*) IS_PUBLIC="false" ;;
  *) IS_PUBLIC="true" ;;
esac

# ─── 9. Firewall ───
echo ""
echo "🔒 Настройка файрвола..."
if command -v ufw &> /dev/null; then
  ufw allow $PORT/tcp 2>/dev/null && echo "   ✅ UFW: порт $PORT открыт" || true
elif command -v firewall-cmd &> /dev/null; then
  firewall-cmd --permanent --add-port=$PORT/tcp 2>/dev/null && firewall-cmd --reload 2>/dev/null && echo "   ✅ firewalld: порт $PORT открыт" || true
else
  echo "   ℹ️  Файрвол не найден. Убедись что порт $PORT доступен."
fi

# ─── 10. Регистрация ноды в Boltby ───
echo ""
echo "📡 Регистрация ноды в Boltby..."

REG_RESPONSE=$(curl -sf -X POST "$BOLTBY_URL/api/gpu-setup" \\
  -H "Content-Type: application/json" \\
  -d "{
    \\"token\\": \\"$TOKEN\\",
    \\"host\\": \\"$CHOSEN_IP\\",
    \\"port\\": \\"$PORT\\",
    \\"name\\": \\"$NODE_NAME\\",
    \\"gpu\\": \\"$GPU_INFO\\",
    \\"vram\\": \\"$GPU_VRAM\\",
    \\"isPublic\\": \\"$IS_PUBLIC\\",
    \\"modelCount\\": \\"$MODEL_COUNT\\"
  }" 2>/dev/null || echo '{"ok":false,"error":"connection failed"}')

REG_OK=$(echo "$REG_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',False))" 2>/dev/null || echo "False")

if [ "$REG_OK" = "True" ]; then
  echo "✅ Нода зарегистрирована в Boltby!"
else
  REG_ERR=$(echo "$REG_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null || echo "unknown")
  echo "⚠️  Автоматическая регистрация не удалась: $REG_ERR"
  echo "   Добавь ноду вручную в Boltby → Settings → GPU Nodes:"
  echo "   Host: $CHOSEN_IP   Port: $PORT"
fi

# ─── 11. Предложение скачать модель ───
if [ "$MODEL_COUNT" = "0" ]; then
  echo ""
  echo "📥 Нет скачанных моделей. Рекомендуемые:"
  if [ -n "$GPU_VRAM" ] && [ "$GPU_VRAM" -gt 20000 ] 2>/dev/null; then
    echo "   • qwen2.5-coder:32b     (большая, лучшее качество)"
    echo "   • devstral:24b           (Mistral для кода)"
    SUGGESTED="qwen2.5-coder:32b"
  elif [ -n "$GPU_VRAM" ] && [ "$GPU_VRAM" -gt 10000 ] 2>/dev/null; then
    echo "   • qwen2.5-coder:14b     (оптимально для 12-16GB)"
    echo "   • deepseek-r1:14b       (reasoning)"
    SUGGESTED="qwen2.5-coder:14b"
  else
    echo "   • qwen2.5-coder:7b      (для 8GB VRAM)"
    echo "   • deepseek-r1:8b        (reasoning, компактная)"
    SUGGESTED="qwen2.5-coder:7b"
  fi
  echo ""
  read -p "   Скачать $SUGGESTED сейчас? [Y/n]: " PULL_MODEL
  PULL_MODEL="\${PULL_MODEL:-Y}"
  case "$PULL_MODEL" in
    [nN]*) echo "   Пропущено. Скачай позже: ollama pull $SUGGESTED" ;;
    *) echo "   Скачивание $SUGGESTED (это может занять несколько минут)..."
       ollama pull "$SUGGESTED" ;;
  esac
fi

# ─── Готово ───
echo ""
echo "★═══════════════════════════════════════════★"
echo "  ✅ GPU нода готова!"
echo ""
echo "  Ollama:   http://$CHOSEN_IP:$PORT"
echo "  GPU:      $GPU_INFO"
[ -n "$GPU_VRAM" ] && echo "  VRAM:     \${GPU_VRAM}MB"
echo "  Моделей:  $MODEL_COUNT"
echo ""
echo "  Управляй через Boltby UI:"
echo "  $BOLTBY_URL → Settings → GPU Nodes"
echo "★═══════════════════════════════════════════★"
echo ""
`;

  return new Response(script, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

// ─── POST: Auto-register node ───

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const body = (await request.json()) as {
      token: string;
      host: string;
      port: string;
      name: string;
      gpu?: string;
      vram?: string;
      isPublic?: string;
      modelCount?: string;
    };

    const tokenData = decodeToken(body.token);

    if (!tokenData) {
      return Response.json({ ok: false, error: 'Invalid or expired token' }, { status: 401 });
    }

    /*
     * We can't directly write to Appwrite from the server route without the API key.
     * Instead, return success with the node info — the client will pick it up
     * via polling or the user will refresh the GPU Nodes tab.
     *
     * For now, store registration in a simple in-memory map that the client can poll.
     * In production, you'd use Appwrite server SDK here.
     */

    const nodeId = `auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Store pending registration (in-memory, survives until server restart)
    if (!globalThis.__pendingGpuNodes) {
      globalThis.__pendingGpuNodes = [];
    }

    (globalThis.__pendingGpuNodes as any[]).push({
      id: nodeId,
      userId: tokenData.uid,
      userName: tokenData.name,
      host: body.host,
      port: body.port || '11434',
      name: body.name || 'GPU Node',
      gpu: body.gpu || '',
      vram: body.vram || '',
      isPublic: body.isPublic === 'true',
      modelCount: parseInt(body.modelCount || '0', 10),
      createdAt: new Date().toISOString(),
    });

    // Keep only last 50 registrations
    if ((globalThis.__pendingGpuNodes as any[]).length > 50) {
      (globalThis.__pendingGpuNodes as any[]).splice(0, (globalThis.__pendingGpuNodes as any[]).length - 50);
    }

    return Response.json({
      ok: true,
      nodeId,
      message: 'Node registered. It will appear in Boltby UI.',
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}
