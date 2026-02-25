#!/bin/bash
set -e

# ══════════════════════════════════════════════════════
#  Boltby + Appwrite — ДЕПЛОЙ НА VPS
#
#  http://45.87.219.104      → Boltby (приложение)
#  http://45.87.219.104:8080 → Appwrite Console (админка БД)
#
#  Режимы:
#    ./deploy.sh          — полный деплой (билд в Docker)
#    ./deploy.sh prebuilt — деплой готового билда (быстрее)
# ══════════════════════════════════════════════════════

SERVER_IP="45.87.219.104"
MODE="${1:-full}"  # full | prebuilt

# ═══ LLM API ключи (заполни что есть) ═══
ANTHROPIC_API_KEY=""
OPENAI_API_KEY=""
OPEN_ROUTER_API_KEY=""
GROQ_API_KEY=""
GOOGLE_GENERATIVE_AI_API_KEY=""
XAI_API_KEY=""

echo "
★═══════════════════════════════════════★
   Boltby + Appwrite Deploy (IP mode)
   Mode: ${MODE}
★═══════════════════════════════════════★
"

# ─── 0. Очистка ───
echo "🧹 Очистка VPS..."
docker stop $(docker ps -aq) 2>/dev/null || true
docker rm $(docker ps -aq) 2>/dev/null || true
docker system prune -af --volumes 2>/dev/null || true
rm -rf /opt/boltby 2>/dev/null || true
fuser -k 80/tcp 2>/dev/null || true
fuser -k 8080/tcp 2>/dev/null || true
echo "✅ Очищено"

# ─── 1. Пакеты ───
echo "📦 Системные пакеты..."
apt-get update -qq
apt-get install -y -qq curl git unzip ufw ca-certificates gnupg python3

# ─── 2. Docker ───
if ! command -v docker &> /dev/null; then
  echo "🐳 Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
else
  echo "✅ Docker ок"
  systemctl start docker
fi
docker compose version &> /dev/null || apt-get install -y -qq docker-compose-plugin

# ─── 2.5. Swap (2GB RAM не хватает для билда) ───
if [ "$MODE" = "full" ]; then
  SWAP_SIZE="4G"
  if [ ! -f /swapfile ]; then
    echo "💾 Создание swap ${SWAP_SIZE}..."
    fallocate -l ${SWAP_SIZE} /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "✅ Swap создан"
  else
    swapon /swapfile 2>/dev/null || true
    echo "✅ Swap уже есть"
  fi
fi

# ─── 3. Firewall ───
echo "🔥 Firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 8080/tcp
ufw --force enable

# ─── 4. Директория + распаковка ───
PROJECT_DIR="/opt/boltby"
mkdir -p "$PROJECT_DIR/app"
cd "$PROJECT_DIR"

ZIP=""
for f in /opt/boltby-appwrite.zip /root/boltby-appwrite.zip /tmp/boltby-appwrite.zip; do
  [ -f "$f" ] && ZIP="$f" && break
done
if [ -z "$ZIP" ]; then
  echo "❌ boltby-appwrite.zip не найден! Загрузи: scp boltby-appwrite.zip root@${SERVER_IP}:/opt/"
  exit 1
fi
unzip -qo "$ZIP" -d "$PROJECT_DIR/app"
echo "✅ Распаковано"

# ─── 5. Секреты ───
AW_SECRET=$(openssl rand -hex 32)
DB_ROOT_PASS=$(openssl rand -hex 16)
DB_PASS=$(openssl rand -hex 16)
REDIS_PASS=$(openssl rand -hex 16)

# ─── 6. .env ───
cat > "$PROJECT_DIR/.env" << EOF
_APP_ENV=production
_APP_LOCALE=en
_APP_DOMAIN=${SERVER_IP}
_APP_DOMAIN_TARGET=${SERVER_IP}
_APP_CONSOLE_WHITELIST_ROOT=enabled
_APP_CONSOLE_WHITELIST_EMAILS=
_APP_CONSOLE_WHITELIST_IPS=
_APP_OPENSSL_KEY_V1=${AW_SECRET}
_APP_REDIS_HOST=redis
_APP_REDIS_PORT=6379
_APP_REDIS_PASS=${REDIS_PASS}
_APP_DB_HOST=mariadb
_APP_DB_PORT=3306
_APP_DB_SCHEMA=appwrite
_APP_DB_USER=appwrite
_APP_DB_PASS=${DB_PASS}
_APP_DB_ROOT_PASS=${DB_ROOT_PASS}
_APP_STORAGE_LIMIT=30000000
_APP_FUNCTIONS_SIZE_LIMIT=30000000
_APP_FUNCTIONS_TIMEOUT=900
VITE_APPWRITE_ENDPOINT=http://${SERVER_IP}:8080/v1
VITE_APPWRITE_PROJECT_ID=boltby
VITE_APPWRITE_DATABASE_ID=boltby_platform
APPWRITE_PROJECT_ID=boltby
APPWRITE_DATABASE_ID=boltby_platform
APPWRITE_API_KEY=
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
OPENAI_API_KEY=${OPENAI_API_KEY}
OPEN_ROUTER_API_KEY=${OPEN_ROUTER_API_KEY}
GROQ_API_KEY=${GROQ_API_KEY}
GOOGLE_GENERATIVE_AI_API_KEY=${GOOGLE_GENERATIVE_AI_API_KEY}
XAI_API_KEY=${XAI_API_KEY}
TOGETHER_API_KEY=
OLLAMA_API_BASE_URL=
HuggingFace_API_KEY=
VITE_LOG_LEVEL=debug
DEFAULT_NUM_CTX=32768
DOMAIN=${SERVER_IP}
NODE_ENV=production
PORT=5173
EOF

# ─── 7. docker-compose.yml ───
cat > "$PROJECT_DIR/docker-compose.yml" << 'YAML'
version: "3.8"
x-logging: &x-logging
  logging:
    driver: json-file
    options: { max-file: "5", max-size: "10m" }

services:
  appwrite:
    image: appwrite/appwrite:1.6
    container_name: appwrite
    restart: unless-stopped
    <<: *x-logging
    networks: [boltby]
    ports: ["8080:80"]
    volumes:
      - appwrite-uploads:/storage/uploads
      - appwrite-cache:/storage/cache
      - appwrite-config:/storage/config
      - appwrite-certificates:/storage/certificates
      - appwrite-functions:/storage/functions
    depends_on: [mariadb, redis]
    environment:
      - _APP_ENV=${_APP_ENV}
      - _APP_LOCALE=${_APP_LOCALE}
      - _APP_DOMAIN=${_APP_DOMAIN}
      - _APP_DOMAIN_TARGET=${_APP_DOMAIN_TARGET}
      - _APP_CONSOLE_WHITELIST_ROOT=${_APP_CONSOLE_WHITELIST_ROOT}
      - _APP_OPENSSL_KEY_V1=${_APP_OPENSSL_KEY_V1}
      - _APP_REDIS_HOST=${_APP_REDIS_HOST}
      - _APP_REDIS_PORT=${_APP_REDIS_PORT}
      - _APP_REDIS_PASS=${_APP_REDIS_PASS}
      - _APP_DB_HOST=${_APP_DB_HOST}
      - _APP_DB_PORT=${_APP_DB_PORT}
      - _APP_DB_SCHEMA=${_APP_DB_SCHEMA}
      - _APP_DB_USER=${_APP_DB_USER}
      - _APP_DB_PASS=${_APP_DB_PASS}
      - _APP_DB_ROOT_PASS=${_APP_DB_ROOT_PASS}
      - _APP_STORAGE_LIMIT=${_APP_STORAGE_LIMIT}
      - _APP_FUNCTIONS_SIZE_LIMIT=${_APP_FUNCTIONS_SIZE_LIMIT}
      - _APP_FUNCTIONS_TIMEOUT=${_APP_FUNCTIONS_TIMEOUT}

  appwrite-realtime:
    image: appwrite/appwrite:1.6
    container_name: appwrite-realtime
    entrypoint: realtime
    restart: unless-stopped
    <<: *x-logging
    networks: [boltby]
    depends_on: [mariadb, redis]
    environment:
      - _APP_ENV=${_APP_ENV}
      - _APP_OPENSSL_KEY_V1=${_APP_OPENSSL_KEY_V1}
      - _APP_REDIS_HOST=${_APP_REDIS_HOST}
      - _APP_REDIS_PORT=${_APP_REDIS_PORT}
      - _APP_REDIS_PASS=${_APP_REDIS_PASS}
      - _APP_DB_HOST=${_APP_DB_HOST}
      - _APP_DB_PORT=${_APP_DB_PORT}
      - _APP_DB_SCHEMA=${_APP_DB_SCHEMA}
      - _APP_DB_USER=${_APP_DB_USER}
      - _APP_DB_PASS=${_APP_DB_PASS}

  appwrite-worker-databases:
    image: appwrite/appwrite:1.6
    entrypoint: worker-databases
    container_name: appwrite-worker-databases
    restart: unless-stopped
    <<: *x-logging
    networks: [boltby]
    depends_on: [mariadb, redis]
    environment:
      - _APP_ENV=${_APP_ENV}
      - _APP_OPENSSL_KEY_V1=${_APP_OPENSSL_KEY_V1}
      - _APP_REDIS_HOST=${_APP_REDIS_HOST}
      - _APP_REDIS_PORT=${_APP_REDIS_PORT}
      - _APP_REDIS_PASS=${_APP_REDIS_PASS}
      - _APP_DB_HOST=${_APP_DB_HOST}
      - _APP_DB_PORT=${_APP_DB_PORT}
      - _APP_DB_SCHEMA=${_APP_DB_SCHEMA}
      - _APP_DB_USER=${_APP_DB_USER}
      - _APP_DB_PASS=${_APP_DB_PASS}

  appwrite-worker-deletes:
    image: appwrite/appwrite:1.6
    entrypoint: worker-deletes
    container_name: appwrite-worker-deletes
    restart: unless-stopped
    <<: *x-logging
    networks: [boltby]
    depends_on: [mariadb, redis]
    volumes:
      - appwrite-uploads:/storage/uploads
      - appwrite-cache:/storage/cache
      - appwrite-certificates:/storage/certificates
    environment:
      - _APP_ENV=${_APP_ENV}
      - _APP_OPENSSL_KEY_V1=${_APP_OPENSSL_KEY_V1}
      - _APP_REDIS_HOST=${_APP_REDIS_HOST}
      - _APP_REDIS_PORT=${_APP_REDIS_PORT}
      - _APP_REDIS_PASS=${_APP_REDIS_PASS}
      - _APP_DB_HOST=${_APP_DB_HOST}
      - _APP_DB_PORT=${_APP_DB_PORT}
      - _APP_DB_SCHEMA=${_APP_DB_SCHEMA}
      - _APP_DB_USER=${_APP_DB_USER}
      - _APP_DB_PASS=${_APP_DB_PASS}

  mariadb:
    image: mariadb:10.11
    container_name: appwrite-mariadb
    restart: unless-stopped
    <<: *x-logging
    networks: [boltby]
    volumes: [appwrite-mariadb:/var/lib/mysql]
    environment:
      MYSQL_ROOT_PASSWORD: ${_APP_DB_ROOT_PASS}
      MYSQL_DATABASE: ${_APP_DB_SCHEMA}
      MYSQL_USER: ${_APP_DB_USER}
      MYSQL_PASSWORD: ${_APP_DB_PASS}
    command: --innodb-flush-method=fsync --innodb-flush-log-at-trx-commit=0

  redis:
    image: redis:7.2-alpine
    container_name: appwrite-redis
    restart: unless-stopped
    <<: *x-logging
    networks: [boltby]
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru --requirepass ${_APP_REDIS_PASS}
    volumes: [appwrite-redis:/data]

  boltby:
    build:
      context: ./app
      dockerfile: Dockerfile
      target: production
    container_name: boltby-app
    restart: unless-stopped
    <<: *x-logging
    networks: [boltby]
    ports: ["80:5173"]
    env_file: .env
    environment:
      - NODE_ENV=production
      - RUNNING_IN_DOCKER=true
      - PORT=5173
      - HOST=0.0.0.0
    depends_on: [appwrite]
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M

volumes:
  appwrite-uploads:
  appwrite-cache:
  appwrite-config:
  appwrite-certificates:
  appwrite-functions:
  appwrite-mariadb:
  appwrite-redis:

networks:
  boltby:
    driver: bridge
YAML

echo "✅ Конфиги созданы"

# ─── 8. Запуск Appwrite сначала ───
echo "🚀 Запуск Appwrite (без boltby)..."
docker compose up -d appwrite appwrite-realtime appwrite-worker-databases appwrite-worker-deletes mariadb redis 2>&1 | tail -5

echo "⏳ Ожидание Appwrite (90 сек)..."
sleep 90

# ─── 9. Проверка Appwrite ───
READY=false
for i in $(seq 1 30); do
  curl -sf "http://localhost:8080/v1/health" > /dev/null 2>&1 && READY=true && break
  sleep 5
done

if [ "$READY" = false ]; then
  echo "⚠️  Appwrite ещё стартует. Подожди и запусти: bash /opt/boltby/init-db.sh"
fi

# ─── 10. Инициализация Appwrite ───
echo "🗄️ Инициализация..."
EP="http://localhost:8080/v1"; PID="boltby"; DBID="boltby_platform"

curl -sf -X POST "${EP}/account" -H "Content-Type: application/json" -H "X-Appwrite-Project: console" \
  -d '{"userId":"unique()","email":"admin@boltby.local","password":"BoltbyAdmin2024!","name":"Admin"}' > /dev/null 2>&1 || true

SESS=$(curl -sf -X POST "${EP}/account/sessions/email" -H "Content-Type: application/json" -H "X-Appwrite-Project: console" \
  -d '{"email":"admin@boltby.local","password":"BoltbyAdmin2024!"}' 2>/dev/null)
COOKIE=$(echo "$SESS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('secret',''))" 2>/dev/null || echo "")

if [ -z "$COOKIE" ]; then
  echo "❌ Appwrite не готов. Подожди и запусти скрипт повторно"
  exit 0
fi

curl -sf -X POST "${EP}/projects" -H "Content-Type: application/json" -H "X-Appwrite-Project: console" \
  -H "Cookie: a_session_console=${COOKIE}" \
  -d "{\"projectId\":\"${PID}\",\"name\":\"Boltby\",\"teamId\":\"unique()\"}" > /dev/null 2>&1 || true

KR=$(curl -sf -X POST "${EP}/projects/${PID}/keys" -H "Content-Type: application/json" -H "X-Appwrite-Project: console" \
  -H "Cookie: a_session_console=${COOKIE}" \
  -d '{"name":"boltby-server","scopes":["users.read","users.write","databases.read","databases.write","collections.read","collections.write","documents.read","documents.write","attributes.read","attributes.write","indexes.read","indexes.write"]}' 2>/dev/null)
AK=$(echo "$KR" | python3 -c "import sys,json; print(json.load(sys.stdin).get('secret',''))" 2>/dev/null || echo "")
[ -n "$AK" ] && sed -i "s/^APPWRITE_API_KEY=.*/APPWRITE_API_KEY=${AK}/" /opt/boltby/.env && echo "  ✅ API ключ"

curl -sf -X POST "${EP}/databases" -H "Content-Type: application/json" -H "X-Appwrite-Project: ${PID}" -H "X-Appwrite-Key: ${AK}" \
  -d "{\"databaseId\":\"${DBID}\",\"name\":\"Boltby Platform\"}" > /dev/null 2>&1 || true

ca() { curl -sf -X POST "${EP}/databases/${DBID}/collections" -H "Content-Type: application/json" -H "X-Appwrite-Project: ${PID}" -H "X-Appwrite-Key: ${AK}" -d "{\"collectionId\":\"$1\",\"name\":\"$2\",\"documentSecurity\":true,\"permissions\":[\"read(\\\"users\\\")\",\"create(\\\"users\\\")\"]}" > /dev/null 2>&1 || true; }
sa() { curl -sf -X POST "${EP}/databases/${DBID}/collections/$1/attributes/string" -H "Content-Type: application/json" -H "X-Appwrite-Project: ${PID}" -H "X-Appwrite-Key: ${AK}" -d "{\"key\":\"$2\",\"size\":$3,\"required\":$4}" > /dev/null 2>&1 || true; }
ix() { curl -sf -X POST "${EP}/databases/${DBID}/collections/$1/indexes" -H "Content-Type: application/json" -H "X-Appwrite-Project: ${PID}" -H "X-Appwrite-Key: ${AK}" -d "{\"key\":\"$2\",\"type\":\"$3\",\"attributes\":$4}" > /dev/null 2>&1 || true; }

echo "  📋 Коллекции..."
ca "conversations" "Conversations"; sleep 2
sa "conversations" "userId" 36 true; sa "conversations" "urlId" 255 false; sa "conversations" "description" 1000 false
sa "conversations" "createdAt" 30 true; sa "conversations" "updatedAt" 30 true; sa "conversations" "metadata" 5000 false
sa "conversations" "localChatId" 36 false; sa "conversations" "chunkCount" 10 false
sleep 3; ix "conversations" "idx_userId" "key" "[\"userId\"]"; ix "conversations" "idx_updatedAt" "key" "[\"updatedAt\"]"

ca "messages" "Messages"; sleep 2
sa "messages" "conversationId" 36 true; sa "messages" "messageId" 100 false; sa "messages" "role" 20 true
sa "messages" "content" 1000000 false; sa "messages" "annotations" 50000 false; sa "messages" "createdAt" 30 true
sleep 3; ix "messages" "idx_conversationId" "key" "[\"conversationId\"]"

ca "snapshots" "Snapshots"; sleep 2
sa "snapshots" "chatId" 36 true; sa "snapshots" "snapshot" 1000000 false
sleep 3; ix "snapshots" "idx_chatId" "unique" "[\"chatId\"]"

ca "site_databases" "Site Databases"; sleep 2
sa "site_databases" "userId" 36 true; sa "site_databases" "name" 255 true
sa "site_databases" "databaseId" 36 false; sa "site_databases" "createdAt" 30 true
sleep 3; ix "site_databases" "idx_userId" "key" "[\"userId\"]"

ca "gpu_nodes" "GPU Nodes"; sleep 2
sa "gpu_nodes" "name" 100 true; sa "gpu_nodes" "host" 255 true; sa "gpu_nodes" "port" 10 true
sa "gpu_nodes" "provider" 20 true; sa "gpu_nodes" "addedBy" 36 true; sa "gpu_nodes" "addedByName" 100 false
sa "gpu_nodes" "isPublic" 10 false
sleep 3; ix "gpu_nodes" "idx_addedBy" "key" "[\"addedBy\"]"

echo "  ✅ Коллекции созданы"

# ─── 11. Билд и запуск Boltby ───
echo "🔨 Сборка и запуск Boltby..."

if [ "$MODE" = "prebuilt" ]; then
  # ── Prebuilt mode: build on host, run in Docker lightweight ──
  echo "   📦 Prebuilt mode: билдим на хосте..."
  
  # Install Node.js if not present
  if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    npm install -g pnpm
  fi
  
  cd "$PROJECT_DIR/app"
  pnpm install
  NODE_OPTIONS="--max-old-space-size=3072" pnpm run build
  
  # Run directly with Node (no Docker for boltby)
  cat > /etc/systemd/system/boltby.service << SYSTEMD
[Unit]
Description=Boltby App
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/boltby/app
EnvironmentFile=/opt/boltby/.env
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SYSTEMD
  
  systemctl daemon-reload
  systemctl enable boltby
  systemctl start boltby
  echo "  ✅ Boltby запущен через systemd"
  
else
  # ── Full mode: build in Docker ──
  echo "   🐳 Docker mode: билд в контейнере (может занять 5-10 мин)..."
  docker compose up -d --build boltby 2>&1 | tail -5
fi

echo ""
echo "★═══════════════════════════════════════════════════★"
echo ""
echo "  ✅ ГОТОВО!"
echo ""
echo "  🌐 Приложение:     http://${SERVER_IP}"
echo "  🔧 Админка БД:     http://${SERVER_IP}:8080"
echo ""
echo "  Appwrite Console:"
echo "    📧 admin@boltby.local"
echo "    🔑 BoltbyAdmin2024!"
echo ""
echo "  ⚠️  СМЕНИ ПАРОЛЬ ROOT: passwd"
echo ""
if [ "$MODE" = "prebuilt" ]; then
  echo "  📋 Управление:"
  echo "    systemctl status boltby"
  echo "    journalctl -u boltby -f"
  echo "    systemctl restart boltby"
fi
echo ""
echo "★═══════════════════════════════════════════════════★"
