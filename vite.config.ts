import { cloudflareDevProxyVitePlugin as remixCloudflareDevProxy, vitePlugin as remixVitePlugin } from '@remix-run/dev';
import UnoCSS from 'unocss/vite';
import { defineConfig, type ViteDevServer } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { optimizeCssModules } from 'vite-plugin-optimize-css-modules';
import tsconfigPaths from 'vite-tsconfig-paths';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

dotenv.config();

// Get detailed git info with fallbacks
const getGitInfo = () => {
  try {
    return {
      commitHash: execSync('git rev-parse --short HEAD').toString().trim(),
      branch: execSync('git rev-parse --abbrev-ref HEAD').toString().trim(),
      commitTime: execSync('git log -1 --format=%cd').toString().trim(),
      author: execSync('git log -1 --format=%an').toString().trim(),
      email: execSync('git log -1 --format=%ae').toString().trim(),
      remoteUrl: execSync('git config --get remote.origin.url').toString().trim(),
      repoName: execSync('git config --get remote.origin.url')
        .toString()
        .trim()
        .replace(/^.*github.com[:/]/, '')
        .replace(/\.git$/, ''),
    };
  } catch {
    return {
      commitHash: 'no-git-info',
      branch: 'unknown',
      commitTime: 'unknown',
      author: 'unknown',
      email: 'unknown',
      remoteUrl: 'unknown',
      repoName: 'unknown',
    };
  }
};

// Read package.json with detailed dependency info
const getPackageJson = () => {
  try {
    const pkgPath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    return {
      name: pkg.name,
      description: pkg.description,
      license: pkg.license,
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {},
      peerDependencies: pkg.peerDependencies || {},
      optionalDependencies: pkg.optionalDependencies || {},
    };
  } catch {
    return {
      name: 'bolt.diy',
      description: 'A DIY LLM interface',
      license: 'MIT',
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
    };
  }
};

const pkg = getPackageJson();
const gitInfo = getGitInfo();

export default defineConfig((config) => {
  return {
    server: {
      host: '0.0.0.0',
      port: 5173,
    },
    define: {
      __COMMIT_HASH: JSON.stringify(gitInfo.commitHash),
      __GIT_BRANCH: JSON.stringify(gitInfo.branch),
      __GIT_COMMIT_TIME: JSON.stringify(gitInfo.commitTime),
      __GIT_AUTHOR: JSON.stringify(gitInfo.author),
      __GIT_EMAIL: JSON.stringify(gitInfo.email),
      __GIT_REMOTE_URL: JSON.stringify(gitInfo.remoteUrl),
      __GIT_REPO_NAME: JSON.stringify(gitInfo.repoName),
      __APP_VERSION: JSON.stringify(process.env.npm_package_version),
      __PKG_NAME: JSON.stringify(pkg.name),
      __PKG_DESCRIPTION: JSON.stringify(pkg.description),
      __PKG_LICENSE: JSON.stringify(pkg.license),
      __PKG_DEPENDENCIES: JSON.stringify(pkg.dependencies),
      __PKG_DEV_DEPENDENCIES: JSON.stringify(pkg.devDependencies),
      __PKG_PEER_DEPENDENCIES: JSON.stringify(pkg.peerDependencies),
      __PKG_OPTIONAL_DEPENDENCIES: JSON.stringify(pkg.optionalDependencies),
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
    },
    build: {
      target: 'esnext',
      rollupOptions: {
        output: {
          format: 'esm',
        },
      },
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
    optimizeDeps: {
      esbuildOptions: {
        define: {
          global: 'globalThis',
        },
      },
    },
    resolve: {
      alias: {
        buffer: 'vite-plugin-node-polyfills/polyfills/buffer',
      },
    },
    plugins: [
      nodePolyfills({
        include: ['buffer', 'process', 'util', 'stream'],
        globals: {
          Buffer: true,
          process: true,
          global: true,
        },
        protocolImports: true,
        exclude: ['child_process', 'fs', 'path'],
      }),
      {
        name: 'buffer-polyfill',
        transform(code, id) {
          if (id.includes('env.mjs')) {
            return {
              code: `import { Buffer } from 'buffer';\n${code}`,
              map: null,
            };
          }

          return null;
        },
      },
      authKeyPlugin(),
      config.mode !== 'test' && remixCloudflareDevProxy(),
      remixVitePlugin({
        future: {
          v3_fetcherPersist: true,
          v3_relativeSplatPath: true,
          v3_throwAbortReason: true,
          v3_lazyRouteDiscovery: true,
        },
      }),
      UnoCSS(),
      tsconfigPaths(),
      chrome129IssuePlugin(),
      config.mode === 'production' && optimizeCssModules({ apply: 'build' }),
    ],
    envPrefix: [
      'VITE_',
      'OPENAI_LIKE_API_BASE_URL',
      'OLLAMA_API_BASE_URL',
      'LMSTUDIO_API_BASE_URL',
      'TOGETHER_API_BASE_URL',
    ],
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
        },
      },
    },
  };
});

function authKeyPlugin() {
  return {
    name: 'auth-key-plugin',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const authKey = process.env.AUTH_KEY;

        if (!authKey) {
          return next();
        }

        const url = new URL(req.url || '/', `http://${req.headers.host}`);

        // Allow HMR websocket and Vite internal requests
        if (
          req.headers.upgrade === 'websocket' ||
          url.pathname.startsWith('/@') ||
          url.pathname.startsWith('/__') ||
          url.pathname.startsWith('/node_modules')
        ) {
          return next();
        }

        const keyFromQuery = url.searchParams.get('key');
        const cookies = parseCookiesSimple(req.headers.cookie || '');
        const keyFromCookie = cookies['bolt_auth'];

        if (keyFromQuery === authKey) {
          res.setHeader(
            'Set-Cookie',
            `bolt_auth=${authKey}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
          );
          res.writeHead(302, { Location: url.pathname });
          res.end();

          return;
        }

        if (keyFromCookie === authKey) {
          return next();
        }

        res.statusCode = 401;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>bolt.diy — Authentication</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .card {
      background: #161b22; border: 1px solid #30363d; border-radius: 12px;
      padding: 2.5rem; max-width: 400px; width: 90%;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #8b949e; margin-bottom: 1.5rem; font-size: 0.9rem; }
    input {
      width: 100%; padding: 0.75rem 1rem; background: #0d1117; border: 1px solid #30363d;
      border-radius: 8px; color: #e6edf3; font-size: 1rem; margin-bottom: 1rem; outline: none;
    }
    input:focus { border-color: #58a6ff; }
    button {
      width: 100%; padding: 0.75rem; background: #238636; border: none; border-radius: 8px;
      color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer;
    }
    button:hover { background: #2ea043; }
    .error { color: #f85149; font-size: 0.85rem; margin-top: 0.5rem; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>bolt.diy</h1>
    <p>Enter the access key to continue</p>
    <form id="authForm">
      <input type="password" id="keyInput" placeholder="Access key" autofocus autocomplete="off" />
      <button type="submit">Unlock</button>
      <div class="error" id="errorMsg">Invalid key. Try again.</div>
    </form>
  </div>
  <script>
    document.getElementById('authForm').addEventListener('submit', function(e) {
      e.preventDefault();
      var key = document.getElementById('keyInput').value;
      if (key) window.location.href = window.location.pathname + '?key=' + encodeURIComponent(key);
      else document.getElementById('errorMsg').style.display = 'block';
    });
  </script>
</body>
</html>`);
      });
    },
  };
}

function parseCookiesSimple(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  for (const part of cookieHeader.split(';')) {
    const [key, ...vals] = part.trim().split('=');

    if (key) {
      cookies[key.trim()] = vals.join('=').trim();
    }
  }

  return cookies;
}

function chrome129IssuePlugin() {
  return {
    name: 'chrome129IssuePlugin',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const raw = req.headers['user-agent']?.match(/Chrom(e|ium)\/([0-9]+)\./);

        if (raw) {
          const version = parseInt(raw[2], 10);

          if (version === 129) {
            res.setHeader('content-type', 'text/html');
            res.end(
              '<body><h1>Please use Chrome Canary for testing.</h1><p>Chrome 129 has an issue with JavaScript modules & Vite local development, see <a href="https://github.com/stackblitz/bolt.new/issues/86#issuecomment-2395519258">for more information.</a></p><p><b>Note:</b> This only impacts <u>local development</u>. `pnpm run build` and `pnpm run start` will work fine in this browser.</p></body>',
            );

            return;
          }
        }

        next();
      });
    },
  };
}