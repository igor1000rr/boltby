import { describe, expect, it, vi } from 'vitest';
import { runAppwriteActionHandler } from './appwrite-handler';

describe('runAppwriteActionHandler', () => {
  it('handles collection operation and writes file when filePath exists', async () => {
    const runFileAction = vi.fn().mockResolvedValue(undefined);
    const onAppwriteAlert = vi.fn();

    const result = await runAppwriteActionHandler({
      action: {
        type: 'appwrite',
        operation: 'collection',
        content: '{"name":"posts"}',
        filePath: '/home/project/pb-setup.js',
      } as any,
      logger: { debug: vi.fn() },
      onAppwriteAlert,
      runFileAction,
    });

    expect(result).toEqual({ success: true });
    expect(onAppwriteAlert).toHaveBeenCalledOnce();
    expect(runFileAction).toHaveBeenCalledOnce();
  });

  it('handles query operation as pending', async () => {
    const result = await runAppwriteActionHandler({
      action: {
        type: 'appwrite',
        operation: 'query',
        content: 'select * from users',
      } as any,
      logger: { debug: vi.fn() },
      onAppwriteAlert: vi.fn(),
      runFileAction: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toEqual({ pending: true });
  });
});
