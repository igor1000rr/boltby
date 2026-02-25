import type { WebContainer } from '@webcontainer/api';
import { path as nodePath } from '~/utils/path';
import { atom, map, type MapStore } from 'nanostores';
import type { ActionAlert, BoltAction, DeployAlert, FileHistory, AppwriteAlert } from '~/types/actions';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';
import type { ActionCallbackData } from './message-parser';
import type { BoltShell } from '~/utils/shell';
import { logStore } from '~/lib/stores/logs';
import { KNOWN_TAILWIND_PLUGINS, scaffoldViteFiles } from './action-fixers';
import { runShellActionHandler } from './handlers/shell-handler';
import { runStartActionHandler } from './handlers/start-handler';
import { runFileActionHandler } from './handlers/file-handler';
import { runBuildActionHandler } from './handlers/build-handler';
import { runAppwriteActionHandler } from './handlers/appwrite-handler';

const logger = createScopedLogger('ActionRunner');

export type ActionStatus = 'pending' | 'running' | 'complete' | 'aborted' | 'failed';

export type BaseActionState = BoltAction & {
  status: Exclude<ActionStatus, 'failed'>;
  abort: () => void;
  executed: boolean;
  abortSignal: AbortSignal;
};

export type FailedActionState = BoltAction &
  Omit<BaseActionState, 'status'> & {
    status: Extract<ActionStatus, 'failed'>;
    error: string;
  };

export type ActionState = BaseActionState | FailedActionState;

type BaseActionUpdate = Partial<Pick<BaseActionState, 'status' | 'abort' | 'executed'>>;

export type ActionStateUpdate =
  | BaseActionUpdate
  | (Omit<BaseActionUpdate, 'status'> & { status: 'failed'; error: string });

type ActionsMap = MapStore<Record<string, ActionState>>;

class ActionCommandError extends Error {
  readonly _output: string;
  readonly _header: string;

  constructor(message: string, output: string) {
    const formattedMessage = `Failed To Execute Shell Command: ${message}\n\nOutput:\n${output}`;
    super(formattedMessage);

    this._header = message;
    this._output = output;

    Object.setPrototypeOf(this, ActionCommandError.prototype);
    this.name = 'ActionCommandError';
  }

  get output() {
    return this._output;
  }
  get header() {
    return this._header;
  }
}

export class ActionRunner {
  #webcontainer: Promise<WebContainer>;
  #currentExecutionPromise: Promise<void> = Promise.resolve();
  #currentStartPromise: Promise<void> = Promise.resolve();
  #shellTerminal: () => BoltShell;
  runnerId = atom<string>(`${Date.now()}`);
  actions: ActionsMap = map({});
  onAlert?: (alert: ActionAlert) => void;
  onAppwriteAlert?: (alert: AppwriteAlert) => void;
  onDeployAlert?: (alert: DeployAlert) => void;
  buildOutput?: { path: string; exitCode: number; output: string };

  constructor(
    webcontainerPromise: Promise<WebContainer>,
    getShellTerminal: () => BoltShell,
    onAlert?: (alert: ActionAlert) => void,
    onAppwriteAlert?: (alert: AppwriteAlert) => void,
    onDeployAlert?: (alert: DeployAlert) => void,
  ) {
    this.#webcontainer = webcontainerPromise;
    this.#shellTerminal = getShellTerminal;
    this.onAlert = onAlert;
    this.onAppwriteAlert = onAppwriteAlert;
    this.onDeployAlert = onDeployAlert;
  }

  addAction(data: ActionCallbackData) {
    const { actionId } = data;

    const actions = this.actions.get();
    const action = actions[actionId];

    if (action) {
      return;
    }

    const abortController = new AbortController();

    this.actions.setKey(actionId, {
      ...data.action,
      status: 'pending',
      executed: false,
      abort: () => {
        abortController.abort();
        this.#updateAction(actionId, { status: 'aborted' });
      },
      abortSignal: abortController.signal,
    });

    this.#currentExecutionPromise.then(() => {
      this.#updateAction(actionId, { status: 'running' });
    });
  }

  async runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    const { actionId } = data;
    const action = this.actions.get()[actionId];

    if (!action) {
      unreachable(`Action ${actionId} not found`);
    }

    if (action.executed) {
      return;
    }

    if (isStreaming && action.type !== 'file') {
      return;
    }

    this.#updateAction(actionId, { ...action, ...data.action, executed: !isStreaming });

    this.#currentExecutionPromise = this.#currentExecutionPromise
      .then(() => {
        return this.#executeAction(actionId, isStreaming);
      })
      .catch((error) => {
        logger.error('Action failed:', error);
      });

    await this.#currentExecutionPromise;

    return;
  }

  async #executeAction(actionId: string, isStreaming: boolean = false) {
    const action = this.actions.get()[actionId];

    this.#updateAction(actionId, { status: 'running' });

    try {
      switch (action.type) {
        case 'shell': {
          await this.#runShellAction(action);
          break;
        }
        case 'file': {
          await this.#runFileAction(action);
          break;
        }
        case 'appwrite': {
          try {
            await runAppwriteActionHandler({
              action,
              logger,
              onAppwriteAlert: this.onAppwriteAlert,
              runFileAction: async (fileAction) => {
                await this.#runFileAction({
                  ...fileAction,
                  changeSource: 'auto-save',
                } as any);
              },
            });
          } catch (error: unknown) {
            this.#updateAction(actionId, {
              status: 'failed',
              error: error instanceof Error ? error.message : 'Appwrite action failed',
            });
            return;
          }
          break;
        }
        case 'build': {
          const buildOutput = await this.#runBuildAction(action);
          this.buildOutput = buildOutput;
          break;
        }
        case 'start': {
          const prevStart = this.#currentStartPromise;

          this.#currentStartPromise = prevStart
            .then(() => this.#runStartAction(action))
            .then(() => this.#updateAction(actionId, { status: 'complete' }))
            .catch((err: Error) => {
              this.#handleActionError(actionId, action, err, { rethrowActionCommandError: false });
            });

          return;
        }
      }

      this.#updateAction(actionId, {
        status: isStreaming ? 'running' : action.abortSignal.aborted ? 'aborted' : 'complete',
      });
    } catch (error) {
      this.#handleActionError(actionId, action, error, { rethrowActionCommandError: true });
    }
  }

  async #runShellAction(action: ActionState) {
    if (action.type !== 'shell') {
      unreachable('Expected shell action');
    }

    const shell = this.#shellTerminal();
    await runShellActionHandler({
      action,
      shell,
      runnerId: this.runnerId,
      webcontainer: this.#webcontainer,
      logger,
      actionCommandError: ActionCommandError,
    });
  }

  async #runStartAction(action: ActionState) {
    if (action.type !== 'start') {
      unreachable('Expected shell action');
    }

    const shell = this.#shellTerminal();

    return runStartActionHandler({
      action,
      shell,
      runnerId: this.runnerId,
      logger,
      actionCommandError: ActionCommandError,
    });
  }

  async #runFileAction(action: ActionState) {
    if (action.type !== 'file') {
      unreachable('Expected file action');
    }

    await runFileActionHandler({
      action,
      webcontainer: this.#webcontainer,
      logger,
      onScaffoldViteForBannedFramework: (wc) => this.#scaffoldViteForBannedFramework(wc),
      onEnsureTailwindPlugins: (wc, plugins) => this.#ensureTailwindPlugins(wc, plugins),
    });
  }

  async #ensureTailwindPlugins(webcontainer: WebContainer, plugins: string[]) {
    try {
      const pkgContent = await webcontainer.fs.readFile('package.json', 'utf-8');
      const pkg = JSON.parse(pkgContent);
      let changed = false;

      if (!pkg.devDependencies) {
        pkg.devDependencies = {};
      }

      for (const plugin of plugins) {
        const version = KNOWN_TAILWIND_PLUGINS[plugin];

        if (!version) {
          continue;
        }

        if (!pkg.dependencies?.[plugin] && !pkg.devDependencies[plugin]) {
          pkg.devDependencies[plugin] = version;
          logger.info(`📦 Auto-add missing Tailwind plugin: ${plugin}@${version}`);
          changed = true;
        }
      }

      if (changed) {
        await webcontainer.fs.writeFile('package.json', JSON.stringify(pkg, null, 2));
        logStore.logSystem('Auto-added missing Tailwind plugins to package.json', { plugins: plugins.join(', ') });
      }
    } catch (err) {
      logger.debug('Could not auto-add Tailwind plugins:', err instanceof Error ? err.message : String(err));
    }
  }

  async #scaffoldViteForBannedFramework(webcontainer: WebContainer) {
    logger.info('🔄 Banned framework → Vite+React: scaffolding essential files');
    logStore.logWarning('Banned framework auto-conversion: creating index.html, vite.config.ts, src/main.tsx');

    try {
      await scaffoldViteFiles(webcontainer as Parameters<typeof scaffoldViteFiles>[0]);
    } catch (err) {
      logger.warn('🔄 Vite scaffold failed:', err instanceof Error ? err.message : String(err));
    }
  }

  #updateAction(id: string, newState: ActionStateUpdate) {
    const actions = this.actions.get();

    this.actions.setKey(id, { ...actions[id], ...newState });
  }

  #handleActionError(
    actionId: string,
    action: ActionState,
    error: unknown,
    options: { rethrowActionCommandError: boolean },
  ) {
    if (action.abortSignal.aborted) {
      return;
    }

    this.#updateAction(actionId, { status: 'failed', error: 'Action failed' });
    logger.error(`[${action.type}]:Action failed\n\n`, error);

    if (!(error instanceof ActionCommandError)) {
      return;
    }

    this.onAlert?.({
      type: 'error',
      title: 'Dev Server Failed',
      description: error.header,
      content: error.output,
    });

    if (options.rethrowActionCommandError) {
      throw error;
    }
  }

  async getFileHistory(filePath: string): Promise<FileHistory | null> {
    try {
      const webcontainer = await this.#webcontainer;
      const historyPath = this.#getHistoryPath(filePath);
      const content = await webcontainer.fs.readFile(historyPath, 'utf-8');

      return JSON.parse(content);
    } catch (error) {
      logger.error('Failed to get file history:', error);
      return null;
    }
  }

  async saveFileHistory(filePath: string, history: FileHistory) {
    const historyPath = this.#getHistoryPath(filePath);

    await this.#runFileAction({
      type: 'file',
      filePath: historyPath,
      content: JSON.stringify(history),
      changeSource: 'auto-save',
    } as any);
  }

  #getHistoryPath(filePath: string) {
    return nodePath.join('.history', filePath);
  }

  async #runBuildAction(action: ActionState) {
    if (action.type !== 'build') {
      unreachable('Expected build action');
    }

    return runBuildActionHandler({
      action,
      webcontainer: this.#webcontainer,
      logger,
      onDeployAlert: this.onDeployAlert,
      actionCommandError: ActionCommandError,
    });
  }

  handleDeployAction(
    stage: 'building' | 'deploying' | 'complete',
    status: ActionStatus,
    details?: {
      url?: string;
      error?: string;
      source?: 'netlify' | 'vercel' | 'github';
    },
  ): void {
    if (!this.onDeployAlert) {
      logger.debug('No deploy alert handler registered');
      return;
    }

    const alertType = status === 'failed' ? 'error' : status === 'complete' ? 'success' : 'info';

    const title =
      stage === 'building'
        ? 'Building Application'
        : stage === 'deploying'
          ? 'Deploying Application'
          : 'Deployment Complete';

    const description =
      status === 'failed'
        ? `${stage === 'building' ? 'Build' : 'Deployment'} failed`
        : status === 'running'
          ? `${stage === 'building' ? 'Building' : 'Deploying'} your application...`
          : status === 'complete'
            ? `${stage === 'building' ? 'Build' : 'Deployment'} completed successfully`
            : `Preparing to ${stage === 'building' ? 'build' : 'deploy'} your application`;

    const buildStatus =
      stage === 'building' ? status : stage === 'deploying' || stage === 'complete' ? 'complete' : 'pending';

    const deployStatus = stage === 'building' ? 'pending' : status;

    this.onDeployAlert({
      type: alertType,
      title,
      description,
      content: details?.error || '',
      url: details?.url,
      stage,
      buildStatus: buildStatus as any,
      deployStatus: deployStatus as any,
      source: details?.source || 'netlify',
    });
  }
}
