import { describe, expect, it, vi } from 'vitest';
import { FileLockService } from './file-lock-service';

describe('FileLockService', () => {
  it('locks and unlocks file via dependency callbacks', () => {
    const files: Record<string, any> = {
      '/a.txt': { type: 'file', content: 'x', isBinary: false, isLocked: false },
    };

    const deps = {
      getFile: (p: string) => files[p],
      getFileOrFolder: (p: string) => files[p],
      getFiles: () => files,
      setFileKey: (p: string, value: any) => {
        files[p] = value;
      },
      setFiles: (value: Record<string, any>) => {
        Object.assign(files, value);
      },
      applyLockToFolderContents: vi.fn(),
      logInfo: vi.fn(),
      logError: vi.fn(),
    };

    const service = new FileLockService(deps);
    expect(service.lockFile('/a.txt', 'c1')).toBe(true);
    expect(files['/a.txt'].isLocked).toBe(true);

    expect(service.unlockFile('/a.txt', 'c1')).toBe(true);
    expect(files['/a.txt'].isLocked).toBe(false);
  });
});
