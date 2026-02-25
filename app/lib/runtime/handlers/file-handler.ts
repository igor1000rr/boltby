import type { WebContainer } from '@webcontainer/api';
import { path as nodePath } from '~/utils/path';
import {
  fixPackageJson,
  fixSourceImports,
  fixTailwindOrPostcssConfig,
  fixViteConfig,
  extractTailwindPlugins,
} from '~/lib/runtime/action-fixers';
import { logStore } from '~/lib/stores/logs';
import { unreachable } from '~/utils/unreachable';

interface LoggerLike {
  debug: (...messages: any[]) => void;
  error: (...messages: any[]) => void;
  info: (...messages: any[]) => void;
}

interface FileActionLike {
  type: 'file';
  filePath: string;
  content: string;
}

export async function runFileActionHandler(params: {
  action: FileActionLike;
  webcontainer: Promise<WebContainer>;
  logger: LoggerLike;
  onScaffoldViteForBannedFramework: (webcontainer: WebContainer) => Promise<void>;
  onEnsureTailwindPlugins: (webcontainer: WebContainer, plugins: string[]) => Promise<void>;
}) {
  const { action, webcontainer, logger, onScaffoldViteForBannedFramework, onEnsureTailwindPlugins } = params;

  if (action.type !== 'file') {
    unreachable('Expected file action');
  }

  const wc = await webcontainer;
  const relativePath = nodePath.relative(wc.workdir, action.filePath);
  const folder = nodePath.dirname(relativePath).replace(/\/+$/g, '');

  if (folder !== '.') {
    try {
      await wc.fs.mkdir(folder, { recursive: true });
      logger.debug('Created folder', folder);
    } catch (error) {
      logger.error('Failed to create folder\n\n', error);
    }
  }

  try {
    let fileContent = action.content;
    let writePath = relativePath;

    if (relativePath === 'package.json' || relativePath.endsWith('/package.json')) {
      const hadBannedFramework =
        /"(next|astro|@angular\/core|solid-start|@builder\.io\/qwik|@sveltejs\/kit|nuxt|gatsby|@remix-run\/react)"\s*:/.test(
          fileContent,
        );
      fileContent = fixPackageJson(fileContent);

      if (
        hadBannedFramework &&
        !/"(next|astro|@angular\/core|solid-start|@builder\.io\/qwik|@sveltejs\/kit|nuxt|gatsby|@remix-run\/react)"\s*:/.test(
          fileContent,
        )
      ) {
        await onScaffoldViteForBannedFramework(wc);
      }
    } else if (/vite\.config\.(ts|js|mjs)$/.test(relativePath)) {
      fileContent = fixViteConfig(fileContent);
    } else if (/(?:postcss|tailwind)\.config\.(js|ts|mjs)$/.test(relativePath)) {
      const requiredPlugins = extractTailwindPlugins(fileContent);
      fileContent = fixTailwindOrPostcssConfig(fileContent, relativePath);
      writePath = relativePath.replace(/\.(js|ts|mjs)$/, '.cjs');

      if (writePath !== relativePath) {
        logger.info(`⚙️ Auto-fix: renamed ${relativePath} → ${writePath}`);
      }

      if (requiredPlugins.length > 0) {
        await onEnsureTailwindPlugins(wc, requiredPlugins);
      }
    } else if (/\.(tsx?|jsx)$/.test(relativePath)) {
      fileContent = fixSourceImports(fileContent, relativePath);
    }

    await wc.fs.writeFile(writePath, fileContent);
    logger.debug(`File written ${writePath}`);
    logStore.logSystem(`File: ${writePath}`, { size: fileContent.length });
  } catch (error) {
    logger.error('Failed to write file\n\n', error);
    throw error;
  }
}
