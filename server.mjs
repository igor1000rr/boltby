/**
 * Boltby — Production Node.js Server
 * Replaces wrangler pages dev for VPS deployment.
 * Serves Remix SSR app with static assets.
 */

import { createRequestHandler } from '@remix-run/node';
import { installGlobals } from '@remix-run/node';
import express from 'express';
import compression from 'compression';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

installGlobals();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '5173', 10);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'production';

// Load the server build
const BUILD_DIR = join(__dirname, 'build');
const SERVER_BUILD = join(BUILD_DIR, 'server', 'index.js');

if (!existsSync(SERVER_BUILD)) {
  console.error(`❌ Server build not found: ${SERVER_BUILD}`);
  console.error('   Run: pnpm run build');
  process.exit(1);
}

const app = express();

// Trust proxy (behind nginx/docker)
app.set('trust proxy', true);

// Compression
app.use(compression());

// Required headers for WebContainer (SharedArrayBuffer)
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

// Serve static assets with long cache
app.use(
  '/assets',
  express.static(join(BUILD_DIR, 'client', 'assets'), {
    immutable: true,
    maxAge: '1y',
  }),
);

// Serve other static files with short cache
app.use(express.static(join(BUILD_DIR, 'client'), { maxAge: '1h' }));

// Create Remix request handler with process.env as cloudflare.env shim
async function createHandler() {
  const build = await import(SERVER_BUILD);

  return createRequestHandler({
    build,
    mode: NODE_ENV,
    getLoadContext() {
      // Shim cloudflare context so routes that use context.cloudflare?.env still work
      return {
        cloudflare: {
          env: process.env,
        },
      };
    },
  });
}

const handler = await createHandler();

// All other requests go to Remix
app.all('*', handler);

app.listen(PORT, HOST, () => {
  console.log(`\n★═══════════════════════════════════════★`);
  console.log(`  Boltby running on http://${HOST}:${PORT}`);
  console.log(`  Mode: ${NODE_ENV}`);
  console.log(`★═══════════════════════════════════════★\n`);
});
