import type { WebContainer } from '@webcontainer/api';
import type { BoltShell } from '~/utils/shell';
import { logStore } from '~/lib/stores/logs';
import { PACKAGE_NAME_CORRECTIONS, sanitizeNpmCommand } from '~/lib/runtime/action-fixers';

interface ShellActionLike {
  type: 'shell';
  content: string;
  abort: () => void;
}

interface RunnerIdLike {
  get: () => string;
}

interface ActionCommandErrorLike {
  new (message: string, output: string): Error;
}

interface LoggerLike {
  debug: (...messages: any[]) => void;
  info: (...messages: any[]) => void;
  warn: (...messages: any[]) => void;
  error: (...messages: any[]) => void;
}

export async function runShellActionHandler(params: {
  action: ShellActionLike;
  shell: BoltShell;
  runnerId: RunnerIdLike;
  webcontainer: Promise<WebContainer>;
  logger: LoggerLike;
  actionCommandError: ActionCommandErrorLike;
}) {
  const { action, shell, runnerId, webcontainer, logger, actionCommandError } = params;
  await shell.ready();

  const sanitizedCommand = sanitizeNpmCommand(action.content);
  logStore.logSystem(`Shell: ${sanitizedCommand.substring(0, 100)}`, { command: sanitizedCommand });

  const resp = await shell.executeCommand(runnerId.get(), sanitizedCommand, () => {
    logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
    action.abort();
  });
  logger.debug(`${action.type} Shell Response: [exit code:${resp?.exitCode}]`);

  if (resp?.exitCode === 0) {
    logStore.logSystem(`Shell OK: ${sanitizedCommand.substring(0, 60)}`, { exitCode: 0 });
    return;
  }

  logStore.logError(`Shell FAIL (exit ${resp?.exitCode}): ${sanitizedCommand.substring(0, 60)}`, undefined, {
    exitCode: resp?.exitCode,
    output: resp?.output?.substring(0, 300),
  });

  const output = resp?.output || '';
  const isNpmInstall = /npm\s+install|npm\s+i\b/.test(sanitizedCommand);

  if (isNpmInstall && output.includes('404')) {
    const retryResult = await retryNpmInstallWithFix({
      shell,
      runnerId,
      webcontainer,
      logger,
      errorOutput: output,
    });

    if (retryResult) {
      return;
    }
  }

  throw new actionCommandError('Failed To Execute Shell Command', output || 'No Output Available');
}

async function retryNpmInstallWithFix(params: {
  shell: BoltShell;
  runnerId: RunnerIdLike;
  webcontainer: Promise<WebContainer>;
  logger: LoggerLike;
  errorOutput: string;
}) {
  const { shell, runnerId, webcontainer, logger, errorOutput } = params;
  const notFoundMatch = errorOutput.match(/404\s+Not Found\s+-\s+GET\s+https?:\/\/registry\.npmjs\.org\/([^\s]+)/);

  if (!notFoundMatch) {
    return false;
  }

  const badPackage = decodeURIComponent(notFoundMatch[1]).replace(/%2f/gi, '/');
  logger.warn(`🔄 npm install failed: package "${badPackage}" not found, attempting auto-fix...`);

  try {
    const wc = await webcontainer;
    const pkgContent = await wc.fs.readFile('package.json', 'utf-8');
    const pkg = JSON.parse(pkgContent);
    let removed = false;

    for (const depKey of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = pkg[depKey as keyof typeof pkg] as Record<string, string> | undefined;

      if (deps && badPackage in deps) {
        const corrected = PACKAGE_NAME_CORRECTIONS[badPackage];

        if (corrected) {
          const ver = deps[badPackage];
          delete deps[badPackage];
          deps[corrected] = ver;
        } else {
          delete deps[badPackage];
        }

        removed = true;
      }
    }

    if (!removed) {
      return false;
    }

    await wc.fs.writeFile('package.json', JSON.stringify(pkg, null, 2));

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const retryResp = await shell.executeCommand(runnerId.get(), 'npm install', () => {});

    return retryResp?.exitCode === 0;
  } catch (e) {
    logger.error('🔄 Auto-fix retry error:', e);
    return false;
  }
}
