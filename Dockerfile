ARG BASE=node:20.18.0-slim

# ═══════════════════════════════════════
# Stage 1: Install dependencies
# ═══════════════════════════════════════
FROM ${BASE} AS deps

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ═══════════════════════════════════════
# Stage 2: Build the app
# ═══════════════════════════════════════
FROM deps AS builder

WORKDIR /app
COPY . .

# Disable wrangler telemetry
RUN mkdir -p /root/.config/.wrangler && \
    echo '{"enabled":false}' > /root/.config/.wrangler/metrics.json

# Build with constrained memory (2GB VPS needs this low)
# If building on VPS with 2GB, use swap (see deploy.sh)
# If building on CI/local, this is fine
RUN NODE_OPTIONS="--max-old-space-size=4096" pnpm run build

# ═══════════════════════════════════════
# Stage 3: Production runtime (lightweight)
# ═══════════════════════════════════════
FROM ${BASE} AS production

WORKDIR /app

# Copy only what's needed for runtime
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server.mjs ./server.mjs

# Environment
ENV NODE_ENV=production \
    PORT=5173 \
    HOST=0.0.0.0 \
    RUNNING_IN_DOCKER=true

EXPOSE 5173

# Use lightweight Node server instead of wrangler
CMD ["node", "server.mjs"]

# ═══════════════════════════════════════
# Alternative: Pre-built image (skip build stage)
# For when you build locally and just copy artifacts
# ═══════════════════════════════════════
FROM ${BASE} AS prebuilt

WORKDIR /app

# This target expects build/ and node_modules/ to be
# copied via docker-compose volumes or COPY from host
COPY package.json server.mjs ./

ENV NODE_ENV=production \
    PORT=5173 \
    HOST=0.0.0.0 \
    RUNNING_IN_DOCKER=true

EXPOSE 5173

CMD ["node", "server.mjs"]
