import type { AppwriteBackendAction } from '~/types/actions';

interface AppwriteAlertLike {
  (alert: { type: 'info'; title: string; description: string; content: string; source: 'appwrite' }): void;
}

interface LoggerLike {
  debug: (...messages: any[]) => void;
}

interface RunFileActionLike {
  (action: { type: 'file'; filePath: string; content: string }): Promise<void>;
}

export async function runAppwriteActionHandler(params: {
  action: AppwriteBackendAction;
  logger: LoggerLike;
  onAppwriteAlert?: AppwriteAlertLike;
  runFileAction: RunFileActionLike;
}): Promise<{ success: true } | { pending: true }> {
  const { action, logger, onAppwriteAlert, runFileAction } = params;
  const { operation, content, filePath } = action;
  logger.debug('[Appwrite Action]:', { operation, filePath, content });

  switch (operation) {
    case 'collection':
      onAppwriteAlert?.({
        type: 'info',
        title: 'Appwrite Collection',
        description: 'Create or update collection',
        content,
        source: 'appwrite',
      });

      if (filePath) {
        await runFileAction({
          type: 'file',
          filePath,
          content,
        });
      }

      return { success: true };

    case 'query':
      onAppwriteAlert?.({
        type: 'info',
        title: 'Appwrite Query',
        description: 'Execute database query',
        content,
        source: 'appwrite',
      });
      return { pending: true };

    default:
      throw new Error(`Unknown Appwrite operation: ${operation}`);
  }
}
