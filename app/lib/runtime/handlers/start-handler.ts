import type { BoltShell } from '~/utils/shell';
import { logStore } from '~/lib/stores/logs';

interface StartActionLike {
  type: 'start';
  content: string;
  abort: () => void;
}

interface RunnerIdLike {
  get: () => string;
}

interface LoggerLike {
  debug: (...messages: any[]) => void;
}

interface ActionCommandErrorLike {
  new (message: string, output: string): Error;
}

export async function runStartActionHandler(params: {
  action: StartActionLike;
  shell: BoltShell;
  runnerId: RunnerIdLike;
  logger: LoggerLike;
  actionCommandError: ActionCommandErrorLike;
}) {
  const { action, shell, runnerId, logger, actionCommandError } = params;
  await shell.ready();

  logStore.logSystem(`Dev server starting: ${action.content}`, { command: action.content });

  const resp = await shell.executeCommand(runnerId.get(), action.content, () => {
    logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
    action.abort();
  });
  logger.debug(`${action.type} Shell Response: [exit code:${resp?.exitCode}]`);

  if (resp?.exitCode != 0) {
    logStore.logError(`Dev server failed (exit ${resp?.exitCode})`, undefined, {
      command: action.content,
      output: resp?.output?.substring(0, 300),
    });
    throw new actionCommandError('Failed To Start Application', resp?.output || 'No Output Available');
  }

  logStore.logSystem('Dev server started', { command: action.content });

  return resp;
}
