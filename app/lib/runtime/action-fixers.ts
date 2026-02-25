import { createScopedLogger } from '~/utils/logger';
import { logStore } from '~/lib/stores/logs';

const logger = createScopedLogger('ActionFixer');

/**
 * LLMs frequently hallucinate npm package names. This map auto-corrects
 * mistakes so `npm install` inside WebContainer doesn't fail with 404.
 */
export const PACKAGE_NAME_CORRECTIONS: Record<string, string> = {
  // Lucide icons
  '@lucide/icons-react': 'lucide-react',
  '@lucide/react': 'lucide-react',
  'lucide-icons': 'lucide-react',
  '@lucide-icons/react': 'lucide-react',
  'lucide-react-icons': 'lucide-react',

  // Heroicons
  '@heroicons/react/solid': '@heroicons/react',
  '@heroicons/react/outline': '@heroicons/react',
  '@heroicons/react/24/solid': '@heroicons/react',
  '@heroicons/react/24/outline': '@heroicons/react',

  // Shadcn (not a real npm package)
  '@shadcn/ui': '@radix-ui/react-slot',
  'shadcn-ui': '@radix-ui/react-slot',

  // Router
  'react-router': 'react-router-dom',
  '@react-router': 'react-router-dom',

  // Icons
  'react-icon': 'react-icons',
  '@react-icons': 'react-icons',
  '@react-icons/all-files': 'react-icons',

  // Tailwind
  'tailwindcss/postcss': 'tailwindcss',
  '@tailwindcss/postcss': 'tailwindcss',
  '@tailwindcss/vite': 'tailwindcss',

  // Animation
  'framer-motion/react': 'framer-motion',
  '@framer-motion': 'framer-motion',
  '@framer-motion/react': 'framer-motion',

  // Toasts
  'react-hot-toast/headless': 'react-hot-toast',
  '@react-hot-toast': 'react-hot-toast',

  // React Query / TanStack
  '@tanstack/query': '@tanstack/react-query',
  'react-query': '@tanstack/react-query',
  '@tanstack/query-core': '@tanstack/react-query',

  // Forms
  '@hookform/resolvers/zod': '@hookform/resolvers',
  '@hookform/resolvers/yup': '@hookform/resolvers',

  // Axios
  '@axios': 'axios',
  'axios/dist': 'axios',

  // Zod
  'zod/lib': 'zod',
  '@zod': 'zod',

  // Date
  moment: 'date-fns',
  'moment-timezone': 'date-fns',

  // Clsx
  classnames: 'clsx',

  // Misc
  '@types/react-dom': '@types/react',

  // Appwrite
  appwrite: 'appwrite',
};

/**
 * Packages that ship their own TypeScript types — @types/* versions don't exist.
 * These will be REMOVED from devDependencies when found.
 */
const PACKAGES_TO_REMOVE = new Set([
  '@shadcn/components',
  '@shadcn/themes',
  'shadcn',
  '@nextui/react',

  '@types/lucide-react',
  '@types/framer-motion',
  '@types/axios',
  '@types/zod',
  '@types/date-fns',
  '@types/clsx',
  '@types/sonner',
  '@types/react-router-dom',
  '@types/react-router',
  '@types/tailwindcss',
  '@types/vite',
]);

const REACT_REQUIRED_DEV_DEPS: Record<string, string> = {
  '@vitejs/plugin-react': '^4.3.0',
};

/**
 * Sanitizes an `npm install` shell command by:
 *  1. Replacing wrong package names using PACKAGE_NAME_CORRECTIONS
 *  2. Removing packages from PACKAGES_TO_REMOVE
 */
export function sanitizeNpmCommand(command: string): string {
  if (!/npm\s+(install|i)\b/.test(command)) {
    return command;
  }

  const parts = command.split(/\s+/);
  const cleaned: string[] = [];
  let changed = false;

  for (const part of parts) {
    const atVersionIdx = part.lastIndexOf('@');
    const bareName = atVersionIdx > 0 ? part.slice(0, atVersionIdx) : part;
    const version = atVersionIdx > 0 ? part.slice(atVersionIdx) : '';

    if (PACKAGES_TO_REMOVE.has(bareName)) {
      logger.info(`📦 Auto-remove from npm command: "${part}"`);
      changed = true;
      continue;
    }

    if (PACKAGE_NAME_CORRECTIONS[bareName]) {
      const corrected = PACKAGE_NAME_CORRECTIONS[bareName] + version;
      logger.info(`📦 Auto-fix in npm command: "${part}" → "${corrected}"`);
      cleaned.push(corrected);
      changed = true;
      continue;
    }

    cleaned.push(part);
  }

  if (!changed) {
    return command;
  }

  return cleaned.join(' ');
}

export function fixPackageJson(content: string): string {
  try {
    const pkg = JSON.parse(content);
    let changed = false;

    const allDepKeys = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

    for (const depKey of allDepKeys) {
      const deps = pkg[depKey];

      if (!deps || typeof deps !== 'object') {
        continue;
      }

      for (const [wrong, correct] of Object.entries(PACKAGE_NAME_CORRECTIONS)) {
        if (wrong in deps) {
          const version = deps[wrong];
          delete deps[wrong];

          if (!(correct in deps)) {
            deps[correct] = version;
          }

          logger.info(`📦 Auto-fix pkg: "${wrong}" → "${correct}"`);
          changed = true;
        }
      }

      for (const badPkg of PACKAGES_TO_REMOVE) {
        if (badPkg in deps) {
          delete deps[badPkg];
          logger.info(`📦 Auto-remove non-existent: "${badPkg}"`);
          changed = true;
        }
      }
    }

    const hasVite = pkg.devDependencies?.vite || pkg.dependencies?.vite;

    if (hasVite && !pkg.type) {
      pkg.type = 'module';
      logger.info('📦 Auto-fix: added "type": "module" for Vite project');
      changed = true;
    }

    const hasReact = pkg.dependencies?.react || pkg.devDependencies?.react;

    if (hasReact && hasVite) {
      if (!pkg.devDependencies) {
        pkg.devDependencies = {};
      }

      for (const [dep, version] of Object.entries(REACT_REQUIRED_DEV_DEPS)) {
        if (!pkg.devDependencies[dep] && !pkg.dependencies?.[dep]) {
          pkg.devDependencies[dep] = version;
          logger.info(`📦 Auto-add missing: "${dep}@${version}"`);
          changed = true;
        }
      }
    }

    for (const depKey of allDepKeys) {
      const deps = pkg[depKey];

      if (!deps) {
        continue;
      }

      if (deps.vite && /^\^?[34]\./.test(deps.vite)) {
        deps.vite = '^5.4.0';
        logger.info('📦 Auto-fix: upgraded vite to ^5.4.0');
        changed = true;
      }

      if (deps['@vitejs/plugin-react'] && /^\^?[123]\./.test(deps['@vitejs/plugin-react'])) {
        deps['@vitejs/plugin-react'] = '^4.3.0';
        logger.info('📦 Auto-fix: upgraded @vitejs/plugin-react to ^4.3.0');
        changed = true;
      }
    }

    if (!pkg.scripts) {
      pkg.scripts = {};
    }

    if (!pkg.scripts.dev && hasVite) {
      pkg.scripts.dev = 'vite';
      logger.info('📦 Auto-fix: added missing "dev": "vite" script');
      changed = true;
    }

    if (pkg.scripts?.dev && pkg.scripts.dev.includes('pb-setup.js && vite')) {
      pkg.scripts.dev = pkg.scripts.dev.replace('pb-setup.js && vite', 'pb-setup.js; vite');
      logger.info('📦 Auto-fix: replaced "&&" with ";" in dev script so vite starts even if pb-setup fails');
      changed = true;
    }

    // 7. Detect and remove banned frameworks, switching to Vite+React
    const BANNED_FRAMEWORKS: Record<string, { label: string; packages: string[] }> = {
      next: {
        label: 'Next.js',
        packages: ['next', 'eslint-config-next', '@next/font', '@next/env'],
      },
      astro: {
        label: 'Astro',
        packages: [
          'astro',
          '@astrojs/react',
          '@astrojs/vue',
          '@astrojs/svelte',
          '@astrojs/solid-js',
          '@astrojs/tailwind',
          '@astrojs/node',
          '@astrojs/vercel',
          '@astrojs/netlify',
        ],
      },
      angular: {
        label: 'Angular',
        packages: [
          '@angular/core',
          '@angular/cli',
          '@angular/common',
          '@angular/compiler',
          '@angular/platform-browser',
          '@angular/platform-browser-dynamic',
          '@angular/router',
          '@angular/forms',
        ],
      },
      solidstart: {
        label: 'SolidStart',
        packages: ['solid-start', '@solidjs/start', '@solidjs/router', '@solidjs/meta'],
      },
      qwik: {
        label: 'Qwik',
        packages: ['@builder.io/qwik', '@builder.io/qwik-city', '@builder.io/sdk-qwik'],
      },
      sveltekit: {
        label: 'SvelteKit',
        packages: [
          '@sveltejs/kit',
          '@sveltejs/adapter-auto',
          '@sveltejs/adapter-node',
          '@sveltejs/adapter-static',
          '@sveltejs/adapter-vercel',
          '@sveltejs/adapter-netlify',
        ],
      },
      nuxt: {
        label: 'Nuxt',
        packages: ['nuxt', '@nuxt/kit', '@nuxt/schema', '@nuxt/devtools'],
      },
      gatsby: {
        label: 'Gatsby',
        packages: ['gatsby', 'gatsby-plugin-react-helmet', 'gatsby-plugin-image', 'gatsby-source-filesystem'],
      },
      remix: {
        label: 'Remix',
        packages: ['@remix-run/react', '@remix-run/node', '@remix-run/serve', '@remix-run/dev'],
      },
    };

    let bannedDetected = false;

    for (const [, fw] of Object.entries(BANNED_FRAMEWORKS)) {
      const found = fw.packages.some((p) => allDepKeys.some((dk) => pkg[dk]?.[p]));

      if (!found) {
        continue;
      }

      logger.warn(`📦 ${fw.label} detected — removing and switching to Vite+React (does not work in WebContainer)`);
      logStore.logWarning(`${fw.label} detected in package.json — auto-converting to Vite+React`, {
        original: fw.label,
      });

      for (const depKey of allDepKeys) {
        if (!pkg[depKey]) {
          continue;
        }

        for (const p of fw.packages) {
          delete pkg[depKey][p];
        }
      }

      bannedDetected = true;
    }

    if (bannedDetected) {
      if (!pkg.dependencies) {
        pkg.dependencies = {};
      }

      if (!pkg.devDependencies) {
        pkg.devDependencies = {};
      }

      if (!pkg.dependencies.react) {
        pkg.dependencies.react = '^18.3.0';
      }

      if (!pkg.dependencies['react-dom']) {
        pkg.dependencies['react-dom'] = '^18.3.0';
      }

      if (!pkg.devDependencies.vite) {
        pkg.devDependencies.vite = '^5.4.0';
      }

      if (!pkg.devDependencies['@vitejs/plugin-react']) {
        pkg.devDependencies['@vitejs/plugin-react'] = '^4.3.0';
      }

      pkg.scripts = pkg.scripts || {};
      pkg.scripts.dev = 'vite';
      pkg.scripts.build = 'vite build';
      pkg.scripts.start = 'vite preview';

      if (!pkg.type) {
        pkg.type = 'module';
      }

      changed = true;
    }

    return changed ? JSON.stringify(pkg, null, 2) : content;
  } catch (err) {
    logger.debug('fixPackageJson parse failed, attempting repair:', err instanceof Error ? err.message : String(err));
    return repairTruncatedJson(content);
  }
}

/**
 * Attempt to repair JSON that was truncated mid-generation (LLM ran out of tokens).
 */
export function repairTruncatedJson(content: string): string {
  let text = content.trim();

  if (!text.startsWith('{')) {
    return content;
  }

  text = text.replace(/,\s*$/, '');

  const lastCompleteEntry = text.lastIndexOf('",');

  if (lastCompleteEntry === -1) {
    return content;
  }

  text = text.substring(0, lastCompleteEntry + 1);

  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;

  for (const ch of text) {
    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === '{') {
      openBraces++;
    } else if (ch === '}') {
      openBraces--;
    } else if (ch === '[') {
      openBrackets++;
    } else if (ch === ']') {
      openBrackets--;
    }
  }

  text += '\n';

  for (let i = 0; i < openBrackets; i++) {
    text += ']';
  }

  for (let i = 0; i < openBraces; i++) {
    text += '}';
  }

  try {
    const repaired = JSON.parse(text);
    logger.warn(`🔧 Repaired truncated package.json (closed ${openBraces} braces, ${openBrackets} brackets)`);

    return JSON.stringify(repaired, null, 2);
  } catch {
    logger.error('🔧 Could not repair truncated package.json');

    return content;
  }
}

export function fixViteConfig(content: string): string {
  let fixed = content;
  let changed = false;

  const hasReactPlugin = /plugin-react|@vitejs\/plugin-react/.test(fixed);
  const definesPlugins = /plugins\s*:/.test(fixed);

  if (!hasReactPlugin && definesPlugins) {
    if (!fixed.includes("from '@vitejs/plugin-react'")) {
      fixed = `import react from '@vitejs/plugin-react';\n${fixed}`;
      changed = true;
    }

    if (!/react\s*\(/.test(fixed)) {
      fixed = fixed.replace(/plugins\s*:\s*\[/, 'plugins: [react(), ');
      changed = true;
    }
  }

  if (!hasReactPlugin && !definesPlugins) {
    fixed = `import react from '@vitejs/plugin-react';\n${fixed}`;
    fixed = fixed.replace(
      /export\s+default\s+defineConfig\s*\(\s*\{/,
      'export default defineConfig({\n  plugins: [react()],',
    );
    changed = true;
  }

  if (fixed.includes('require(') && fixed.includes('import ')) {
    fixed = fixed.replace(/const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\);?/g, "import $1 from '$2';");
    changed = true;
  }

  if (changed) {
    logger.info('⚙️ Auto-fix: patched vite.config');
  }

  return fixed;
}

/**
 * Known Tailwind CSS plugins — if referenced in config, auto-add to package.json.
 * Maps require'd package name to npm version.
 */
const KNOWN_TAILWIND_PLUGINS: Record<string, string> = {
  'tailwindcss-animate': '^1.0.7',
  '@tailwindcss/typography': '^0.5.15',
  '@tailwindcss/forms': '^0.5.9',
  '@tailwindcss/aspect-ratio': '^0.4.2',
  '@tailwindcss/container-queries': '^0.1.1',
  daisyui: '^4.12.0',
  flowbite: '^2.5.0',
};

/**
 * Extract plugin package names from a tailwind/postcss config file.
 * Looks for require('package-name') patterns.
 */
export function extractTailwindPlugins(content: string): string[] {
  const plugins: string[] = [];
  const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;

  while ((match = requirePattern.exec(content)) !== null) {
    const pkg = match[1];

    if (pkg !== 'tailwindcss' && pkg !== 'autoprefixer' && pkg !== 'postcss') {
      plugins.push(pkg);
    }
  }

  return plugins;
}

/**
 * Fix tailwind.config / postcss.config:
 * - Strip fake "defineConfig" import (doesn't exist in tailwindcss)
 * - Convert ESM export default to CommonJS module.exports
 * - Wrap unknown plugin requires in try-catch to prevent crashes
 */
export function fixTailwindOrPostcssConfig(content: string, filePath: string): string {
  let fixed = content;

  if (/import\s*\{?\s*defineConfig\s*\}?\s*from\s*['"]tailwindcss['"]/.test(fixed)) {
    fixed = fixed.replace(/import\s*\{?\s*defineConfig\s*\}?\s*from\s*['"]tailwindcss['"]\s*;?\n?/g, '');
    logger.info(`⚙️ Auto-fix ${filePath}: removed fake defineConfig import from tailwindcss`);
  }

  if (/export\s+default\s+defineConfig\s*\(/.test(fixed)) {
    fixed = fixed.replace(/export\s+default\s+defineConfig\s*\(\s*/, 'module.exports = ');
    fixed = fixed.replace(/\)\s*;?\s*$/, ';\n');
    logger.info(`⚙️ Auto-fix ${filePath}: defineConfig() → module.exports`);
  }

  if (/export\s+default\s+\{/.test(fixed)) {
    fixed = fixed.replace(/export\s+default\s+/, 'module.exports = ');
    logger.info(`⚙️ Auto-fix ${filePath}: export default → module.exports`);
  }

  fixed = fixed.replace(/^import\s+.*from\s+['"].*['"]\s*;?\n?/gm, '');

  if (!fixed.includes('module.exports')) {
    const objMatch = fixed.match(/(\{[\s\S]*\})\s*;?\s*$/);

    if (objMatch) {
      fixed = 'module.exports = ' + objMatch[1] + ';\n';
      logger.info(`⚙️ Auto-fix ${filePath}: wrapped object in module.exports`);
    }
  }

  // Wrap plugin require() calls in try-catch to prevent crash if plugin is not installed
  const pluginRequires = extractTailwindPlugins(fixed);

  if (pluginRequires.length > 0 && /plugins\s*:/.test(fixed)) {
    for (const pkg of pluginRequires) {
      const requireLiteral = `require('${pkg}')`;
      const requireLiteralDQ = `require("${pkg}")`;

      if (fixed.includes(requireLiteral) || fixed.includes(requireLiteralDQ)) {
        const safeRequire = `(() => { try { return require('${pkg}'); } catch (e) { console.warn('[tailwind plugin missing]', '${pkg}'); return () => ({}); } })()`;
        fixed = fixed.replace(
          new RegExp(`require\\s*\\(\\s*['"]${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\)`, 'g'),
          safeRequire,
        );
        logger.info(`⚙️ Auto-fix ${filePath}: wrapped require('${pkg}') in try-catch`);
      }
    }
  }

  return fixed;
}

export { KNOWN_TAILWIND_PLUGINS };

export async function scaffoldViteFiles(webcontainer: {
  fs: {
    readFile(path: string, encoding?: 'utf-8'): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  };
}) {
  const existsCheck = async (p: string) => {
    try {
      await webcontainer.fs.readFile(p, 'utf-8');
      return true;
    } catch {
      return false;
    }
  };

  if (!(await existsCheck('index.html'))) {
    await webcontainer.fs.writeFile(
      'index.html',
      [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>App</title></head>',
        '<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>',
        '</html>',
      ].join('\n'),
    );
    logger.info('🔄 Created index.html');
  }

  if (!(await existsCheck('vite.config.ts')) && !(await existsCheck('vite.config.js'))) {
    await webcontainer.fs.writeFile(
      'vite.config.ts',
      "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()], resolve: { alias: { '@': '/src' } } });\n",
    );
    logger.info('🔄 Created vite.config.ts');
  }

  await webcontainer.fs.mkdir('src', { recursive: true });

  if (!(await existsCheck('src/main.tsx')) && !(await existsCheck('src/main.ts'))) {
    await webcontainer.fs.writeFile(
      'src/main.tsx',
      "import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\n\nReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);\n",
    );
    logger.info('🔄 Created src/main.tsx');
  }

  if (!(await existsCheck('src/App.tsx')) && !(await existsCheck('src/App.js'))) {
    await webcontainer.fs.writeFile(
      'src/App.tsx',
      "export default function App() { return <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'system-ui'}}><h1>App is running</h1></div>; }\n",
    );
    logger.info('🔄 Created src/App.tsx');
  }
}

export function fixSourceImports(content: string, filePath: string): string {
  let fixed = content;
  let changed = false;

  const lucideImportPattern = /from\s+['"]@lucide\/(?:icons-react|react)['"]/g;

  if (lucideImportPattern.test(fixed)) {
    fixed = fixed.replace(lucideImportPattern, "from 'lucide-react'");
    logger.info(`⚙️ Auto-fix imports in ${filePath}: @lucide/* → lucide-react`);
    changed = true;
  }

  const routerPattern = /from\s+['"]react-router['"]/g;

  if (routerPattern.test(fixed) && !fixed.includes('react-router-dom')) {
    fixed = fixed.replace(routerPattern, "from 'react-router-dom'");
    logger.info(`⚙️ Auto-fix imports in ${filePath}: react-router → react-router-dom`);
    changed = true;
  }

  const queryPattern = /from\s+['"]react-query['"]/g;

  if (queryPattern.test(fixed)) {
    fixed = fixed.replace(queryPattern, "from '@tanstack/react-query'");
    logger.info(`⚙️ Auto-fix imports in ${filePath}: react-query → @tanstack/react-query`);
    changed = true;
  }

  // Appwrite uses named imports - fix if someone uses default import
  const appwriteDefaultImport = /import\s+Appwrite\s+from\s*['"]appwrite['"]/g;

  if (appwriteDefaultImport.test(fixed)) {
    fixed = fixed.replace(appwriteDefaultImport, "import { Client, Databases, Account, ID, Query } from 'appwrite'");
    logger.info(`⚙️ Auto-fix imports in ${filePath}: default Appwrite → named imports`);
    changed = true;
  }

  const axiosNamedImport = /import\s*\{\s*axios\s*\}\s*from\s*['"]axios['"]/g;

  if (axiosNamedImport.test(fixed)) {
    fixed = fixed.replace(axiosNamedImport, "import axios from 'axios'");
    logger.info(`⚙️ Auto-fix imports in ${filePath}: { axios } → default import`);
    changed = true;
  }

  const framerPattern = /from\s+['"]framer-motion\/react['"]/g;

  if (framerPattern.test(fixed)) {
    fixed = fixed.replace(framerPattern, "from 'framer-motion'");
    logger.info(`⚙️ Auto-fix imports in ${filePath}: framer-motion/react → framer-motion`);
    changed = true;
  }

  if (
    fixed.includes('appwrite') &&
    fixed.includes('useEffect') &&
    fixed.includes('.listDocuments(') &&
    !fixed.includes('.catch(')
  ) {
    const bareListDocs = /(\.listDocuments\([^)]*\))(?![\s\S]*?\.catch)/g;

    if (bareListDocs.test(fixed)) {
      fixed = fixed.replace(bareListDocs, '$1.catch(() => ({ documents: [] }))');
      logger.info(`⚙️ Auto-fix: added .catch() to bare Appwrite listDocuments() in ${filePath}`);
      changed = true;
    }
  }

  if (/\.(tsx?|jsx)$/.test(filePath) && fixed.includes('require(')) {
    fixed = fixed.replace(/const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\);?/g, "import $1 from '$2';");

    if (fixed !== content) {
      logger.info(`⚙️ Auto-fix: converted require() → import in ${filePath}`);
      changed = true;
    }
  }

  return changed ? fixed : content;
}
