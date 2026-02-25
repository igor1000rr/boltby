import { describe, expect, it, vi } from 'vitest';
import { runStartActionHandler } from './start-handler';

describe('runStartActionHandler', () => {
  it('starts successfully when exitCode is 0', async () => {
    const shell = {
      ready: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, output: 'ok' }),
    } as any;

    const res = await runStartActionHandler({
      action: { type: 'start', content: 'npm run dev', abort: vi.fn() },
      shell,
      runnerId: { get: () => 'runner-1' },
      logger: { debug: vi.fn() },
      actionCommandError: class extends Error {},
    });

    expect(res?.exitCode).toBe(0);
    expect(shell.executeCommand).toHaveBeenCalledOnce();
  });

  it('throws on non-zero exit code', async () => {
    const shell = {
      ready: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 1, output: 'fail' }),
    } as any;

    await expect(
      runStartActionHandler({
        action: { type: 'start', content: 'npm run dev', abort: vi.fn() },
        shell,
        runnerId: { get: () => 'runner-1' },
        logger: { debug: vi.fn() },
        actionCommandError: class extends Error {},
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('wires abort callback through executeCommand', async () => {
    const abort = vi.fn();
    const shell = {
      ready: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockImplementation(async (_id: string, _cmd: string, onAbort: () => void) => {
        onAbort();
        return { exitCode: 0, output: 'ok' };
      }),
    } as any;

    await runStartActionHandler({
      action: { type: 'start', content: 'npm run dev', abort },
      shell,
      runnerId: { get: () => 'runner-1' },
      logger: { debug: vi.fn() },
      actionCommandError: class extends Error {},
    });

    expect(abort).toHaveBeenCalledOnce();
  });
});
