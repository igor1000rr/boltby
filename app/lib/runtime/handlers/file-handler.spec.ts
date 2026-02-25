import { describe, expect, it, vi } from 'vitest';
import { runFileActionHandler } from './file-handler';

describe('runFileActionHandler', () => {
  it('creates folder and writes file', async () => {
    const wc = {
      workdir: '/home/project',
      fs: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    await runFileActionHandler({
      action: {
        type: 'file',
        filePath: '/home/project/src/App.tsx',
        content: 'export default function App() { return null; }',
      },
      webcontainer: Promise.resolve(wc),
      logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
      onScaffoldViteForBannedFramework: vi.fn().mockResolvedValue(undefined),
      onEnsureTailwindPlugins: vi.fn().mockResolvedValue(undefined),
    });

    expect(wc.fs.mkdir).toHaveBeenCalledWith('src', { recursive: true });
    expect(wc.fs.writeFile).toHaveBeenCalledOnce();
  });

  it('triggers banned framework scaffold when package.json contains next', async () => {
    const wc = {
      workdir: '/home/project',
      fs: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    const onScaffold = vi.fn().mockResolvedValue(undefined);

    await runFileActionHandler({
      action: {
        type: 'file',
        filePath: '/home/project/package.json',
        content: JSON.stringify({
          dependencies: { next: '^14.0.0', react: '^18.0.0' },
        }),
      },
      webcontainer: Promise.resolve(wc),
      logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
      onScaffoldViteForBannedFramework: onScaffold,
      onEnsureTailwindPlugins: vi.fn().mockResolvedValue(undefined),
    });

    expect(onScaffold).toHaveBeenCalledOnce();
  });

  it('renames tailwind config to cjs and requests plugin ensure', async () => {
    const wc = {
      workdir: '/home/project',
      fs: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    const onEnsure = vi.fn().mockResolvedValue(undefined);

    await runFileActionHandler({
      action: {
        type: 'file',
        filePath: '/home/project/tailwind.config.js',
        content: "module.exports = { plugins: [require('tailwindcss-animate')] }",
      },
      webcontainer: Promise.resolve(wc),
      logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
      onScaffoldViteForBannedFramework: vi.fn().mockResolvedValue(undefined),
      onEnsureTailwindPlugins: onEnsure,
    });

    expect(wc.fs.writeFile).toHaveBeenCalled();

    const [writePath] = wc.fs.writeFile.mock.calls[0];
    expect(writePath).toBe('tailwind.config.cjs');
    expect(onEnsure).toHaveBeenCalledOnce();
  });

  it('throws when writeFile fails', async () => {
    const writeError = new Error('Disk full');
    const wc = {
      workdir: '/home/project',
      fs: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockRejectedValue(writeError),
      },
    } as any;
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };

    await expect(
      runFileActionHandler({
        action: {
          type: 'file',
          filePath: '/home/project/src/App.tsx',
          content: 'export default function App() { return null; }',
        },
        webcontainer: Promise.resolve(wc),
        logger,
        onScaffoldViteForBannedFramework: vi.fn().mockResolvedValue(undefined),
        onEnsureTailwindPlugins: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow('Disk full');

    expect(logger.error).toHaveBeenCalledWith('Failed to write file\n\n', writeError);
  });
});
