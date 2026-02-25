#!/bin/bash
# ============================================
# bolt.diy — Deployment script for vast.ai GPU server
# ============================================
# Usage:
#   chmod +x deploy-vastai.sh
#   ./deploy-vastai.sh
#
# Prerequisites:
#   - SSH access to vast.ai server
#   - .env.local configured with API keys
# ============================================

set -e

SERVER_HOST="201.165.125.8"
SERVER_PORT="20016"
SERVER_USER="root"
REMOTE_DIR="/root/bolt-diy"

echo "================================================"
echo "  bolt.diy — Deploying to vast.ai GPU server"
echo "================================================"

# --- Step 1: Install dependencies on server ---
echo ""
echo "[1/5] Setting up server environment..."
ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_HOST" << 'REMOTE_SETUP'
set -e

# Install Node.js 20 if not present
if ! command -v node &> /dev/null; then
    echo "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

# Install pnpm if not present
if ! command -v pnpm &> /dev/null; then
    echo "Installing pnpm..."
    npm install -g pnpm
fi

# Install tmux if not present
if ! command -v tmux &> /dev/null; then
    apt-get install -y tmux
fi

# Install git if not present
if ! command -v git &> /dev/null; then
    apt-get install -y git
fi

echo "Node: $(node --version), pnpm: $(pnpm --version)"
echo "Server environment ready."
REMOTE_SETUP

# --- Step 2: Install Ollama on server ---
echo ""
echo "[2/5] Installing Ollama on server..."
ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_HOST" << 'REMOTE_OLLAMA'
set -e

if ! command -v ollama &> /dev/null; then
    echo "Installing Ollama..."
    curl -fsSL https://ollama.ai/install.sh | sh
else
    echo "Ollama already installed: $(ollama --version)"
fi

# Start Ollama if not running
if ! pgrep -x "ollama" > /dev/null; then
    echo "Starting Ollama..."
    nohup ollama serve > /var/log/ollama.log 2>&1 &
    sleep 3
fi

echo "Ollama status: $(curl -s http://127.0.0.1:11434/api/tags | head -c 100)"
REMOTE_OLLAMA

# --- Step 3: Download models ---
echo ""
echo "[3/5] Downloading AI models (this may take a while)..."
ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_HOST" << 'REMOTE_MODELS'
set -e

echo "Pulling models for RTX 5090 (32 GB VRAM)..."

models=(
    "qwen2.5-coder:32b"
    "deepseek-coder-v2:16b"
    "deepseek-r1:14b"
    "llama3.1:8b"
    "mistral:7b"
)

for model in "${models[@]}"; do
    echo ""
    echo "--- Pulling $model ---"
    ollama pull "$model" || echo "Warning: Failed to pull $model, skipping..."
done

echo ""
echo "Installed models:"
ollama list
REMOTE_MODELS

# --- Step 4: Deploy bolt.diy code ---
echo ""
echo "[4/5] Deploying bolt.diy to server..."

# Sync project to server (exclude node_modules, .git)
rsync -avz --progress \
    -e "ssh -p $SERVER_PORT" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.cache' \
    --exclude='build' \
    ./ "$SERVER_USER@$SERVER_HOST:$REMOTE_DIR/"

# Install dependencies on server
ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_HOST" << REMOTE_INSTALL
set -e
cd "$REMOTE_DIR"
pnpm install
echo "Dependencies installed."
REMOTE_INSTALL

# --- Step 5: Start bolt.diy ---
echo ""
echo "[5/5] Starting bolt.diy on server..."
ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_HOST" << REMOTE_START
set -e

# Kill existing bolt.diy if running
pkill -f "remix vite:dev" 2>/dev/null || true

# Ensure Ollama is running
if ! pgrep -x "ollama" > /dev/null; then
    nohup ollama serve > /var/log/ollama.log 2>&1 &
    sleep 2
fi

# Start bolt.diy in a tmux session
tmux kill-session -t bolt 2>/dev/null || true
tmux new-session -d -s bolt "cd $REMOTE_DIR && pnpm run dev"

sleep 5
echo ""
echo "================================================"
echo "  bolt.diy is running!"
echo "================================================"
echo ""
echo "  Access URL: http://$SERVER_HOST:5173"
echo "  Auth key:   $(grep AUTH_KEY $REMOTE_DIR/.env.local | cut -d= -f2)"
echo ""
echo "  First visit: http://$SERVER_HOST:5173?key=\$(grep AUTH_KEY $REMOTE_DIR/.env.local | cut -d= -f2)"
echo ""
echo "  SSH into tmux: ssh -p $SERVER_PORT $SERVER_USER@$SERVER_HOST -t 'tmux attach -t bolt'"
echo "================================================"
REMOTE_START

echo ""
echo "Deployment complete!"
echo ""
echo "Open in browser: http://$SERVER_HOST:5173"
echo "Or with auth key: http://$SERVER_HOST:5173?key=$(grep AUTH_KEY .env.local | cut -d= -f2)"
