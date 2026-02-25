import { describe, expect, it, vi } from 'vitest';
import { runShellActionHandler } from './shell-handler';

class TestActionCommandError extends Error {
  constructor(message: string, output: string) {
    super(`${message}: ${output}`);
  }
}

describe('runShellActionHandler', () => {
  it('completes successfully on zero exit code', async () => {
    const shell = {
      ready: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, output: 'ok' }),
    } as any;

    await runShellActionHandler({
      action: { type: 'shell', content: 'npm install react', abort: vi.fn() },
      shell,
      runnerId: { get: () => 'runner-1' },
      webcontainer: Promise.resolve({ fs: {} } as any),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      actionCommandError: TestActionCommandError,
    });

    expect(shell.executeCommand).toHaveBeenCalledTimes(1);
  });

  it('retries npm install after 404 package fix', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        output: 'npm error 404 Not Found - GET https://registry.npmjs.org/%40lucide%2freact',
      })
      .mockResolvedValueOnce({ exitCode: 0, output: 'done' });

    const packageJson = JSON.stringify({
      dependencies: { '@lucide/react': '^1.0.0' },
    });

    const wc = {
      fs: {
        readFile: vi.fn().mockResolvedValue(packageJson),
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    await runShellActionHandler({
      action: { type: 'shell', content: 'npm i @lucide/react', abort: vi.fn() },
      shell: { ready: vi.fn().mockResolvedValue(undefined), executeCommand } as any,
      runnerId: { get: () => 'runner-1' },
      webcontainer: Promise.resolve(wc),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      actionCommandError: TestActionCommandError,
    });

    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(wc.fs.writeFile).toHaveBeenCalledOnce();
  });

  it('throws when command fails and retry path does not recover', async () => {
    const shell = {
      ready: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 1, output: 'bad output' }),
    } as any;

    await expect(
      runShellActionHandler({
        action: { type: 'shell', content: 'npm run bad', abort: vi.fn() },
        shell,
        runnerId: { get: () => 'runner-1' },
        webcontainer: Promise.resolve({ fs: {} } as any),
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        actionCommandError: TestActionCommandError,
      }),
    ).rejects.toBeInstanceOf(TestActionCommandError);
  });

  it('throws when retry npm install also fails', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        output: 'npm error 404 Not Found - GET https://registry.npmjs.org/%40lucide%2freact',
      })
      .mockResolvedValueOnce({ exitCode: 1, output: 'still failing' });

    const packageJson = JSON.stringify({
      dependencies: { '@lucide/react': '^1.0.0' },
    });

    const wc = {
      fs: {
        readFile: vi.fn().mockResolvedValue(packageJson),
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    await expect(
      runShellActionHandler({
        action: { type: 'shell', content: 'npm i @lucide/react', abort: vi.fn() },
        shell: { ready: vi.fn().mockResolvedValue(undefined), executeCommand } as any,
        runnerId: { get: () => 'runner-1' },
        webcontainer: Promise.resolve(wc),
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        actionCommandError: TestActionCommandError,
      }),
    ).rejects.toBeInstanceOf(TestActionCommandError);

    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(wc.fs.writeFile).toHaveBeenCalledOnce();
  });
});
