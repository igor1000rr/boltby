import { describe, expect, it, vi } from 'vitest';
import { runBuildActionHandler } from './build-handler';

class TestActionCommandError extends Error {
  constructor(message: string, output: string) {
    super(`${message}: ${output}`);
  }
}

function createBuildProcess(exitCode: number, output: string) {
  return {
    output: {
      pipeTo: vi.fn(async (writable: WritableStream<string>) => {
        const writer = writable.getWriter();
        await writer.write(output);
        await writer.close();
      }),
    },
    exit: Promise.resolve(exitCode),
  };
}

describe('runBuildActionHandler', () => {
  it('returns found build directory on successful build', async () => {
    const wc = {
      workdir: '/home/project',
      spawn: vi.fn().mockResolvedValue(createBuildProcess(0, 'build ok')),
      fs: {
        readdir: vi.fn(async (path: string) => {
          if (path.endsWith('/dist')) {
            return [];
          }

          throw new Error('not found');
        }),
      },
    } as any;

    const result = await runBuildActionHandler({
      action: { type: 'build' },
      webcontainer: Promise.resolve(wc),
      logger: { debug: vi.fn() },
      onDeployAlert: vi.fn(),
      actionCommandError: TestActionCommandError,
    });

    expect(result.path).toBe('/home/project/dist');
    expect(result.exitCode).toBe(0);
  });

  it('throws ActionCommandError on failed build', async () => {
    const wc = {
      workdir: '/home/project',
      spawn: vi.fn().mockResolvedValue(createBuildProcess(1, 'build fail')),
      fs: { readdir: vi.fn() },
    } as any;

    await expect(
      runBuildActionHandler({
        action: { type: 'build' },
        webcontainer: Promise.resolve(wc),
        logger: { debug: vi.fn() },
        onDeployAlert: vi.fn(),
        actionCommandError: TestActionCommandError,
      }),
    ).rejects.toBeInstanceOf(TestActionCommandError);
  });

  it('falls back to dist when no known build directory exists', async () => {
    const wc = {
      workdir: '/home/project',
      spawn: vi.fn().mockResolvedValue(createBuildProcess(0, 'build ok')),
      fs: {
        readdir: vi.fn().mockRejectedValue(new Error('not found')),
      },
    } as any;
    const logger = { debug: vi.fn() };

    const result = await runBuildActionHandler({
      action: { type: 'build' },
      webcontainer: Promise.resolve(wc),
      logger,
      onDeployAlert: vi.fn(),
      actionCommandError: TestActionCommandError,
    });

    expect(result.path).toBe('/home/project/dist');
    expect(wc.fs.readdir).toHaveBeenCalledTimes(6);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('No build directory found, defaulting to:'));
  });
});
