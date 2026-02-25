import { addLockedFile, addLockedFolder, removeLockedFile, removeLockedFolder } from '~/lib/persistence/lockedFiles';
import { getCurrentChatId } from '~/utils/fileLocks';
import type { Dirent, FileMap } from '~/lib/stores/files';

type LockableEntry = Dirent;
type LockableMap = FileMap;

interface FileLockServiceDeps {
  getFile: (filePath: string) => LockableEntry | undefined;
  getFileOrFolder: (path: string) => LockableEntry | undefined;
  getFiles: () => LockableMap;
  setFileKey: (path: string, value: LockableEntry) => void;
  setFiles: (value: LockableMap) => void;
  applyLockToFolderContents: (files: LockableMap, updates: LockableMap, folderPath: string) => void;
  logInfo: (message: string) => void;
  logError: (message: string) => void;
}

export class FileLockService {
  private readonly _deps: FileLockServiceDeps;

  constructor(deps: FileLockServiceDeps) {
    this._deps = deps;
  }

  lockFile(filePath: string, chatId?: string) {
    const file = this._deps.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      this._deps.logError(`Cannot lock non-existent file: ${filePath}`);
      return false;
    }

    this._deps.setFileKey(filePath, { ...file, isLocked: true });
    addLockedFile(currentChatId, filePath);
    this._deps.logInfo(`File locked: ${filePath} for chat: ${currentChatId}`);

    return true;
  }

  lockFolder(folderPath: string, chatId?: string) {
    const folder = this._deps.getFileOrFolder(folderPath);
    const currentFiles = this._deps.getFiles();
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      this._deps.logError(`Cannot lock non-existent folder: ${folderPath}`);
      return false;
    }

    const updates: LockableMap = {
      [folderPath]: {
        type: folder.type,
        isLocked: true,
      },
    };

    this._deps.applyLockToFolderContents(currentFiles, updates, folderPath);
    this._deps.setFiles({ ...currentFiles, ...updates });
    addLockedFolder(currentChatId, folderPath);
    this._deps.logInfo(`Folder locked: ${folderPath} for chat: ${currentChatId}`);

    return true;
  }

  unlockFile(filePath: string, chatId?: string) {
    const file = this._deps.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      this._deps.logError(`Cannot unlock non-existent file: ${filePath}`);
      return false;
    }

    this._deps.setFileKey(filePath, {
      ...file,
      isLocked: false,
      lockedByFolder: undefined,
    });
    removeLockedFile(currentChatId, filePath);
    this._deps.logInfo(`File unlocked: ${filePath} for chat: ${currentChatId}`);

    return true;
  }

  unlockFolder(folderPath: string, chatId?: string) {
    const folder = this._deps.getFileOrFolder(folderPath);
    const currentFiles = this._deps.getFiles();
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      this._deps.logError(`Cannot unlock non-existent folder: ${folderPath}`);
      return false;
    }

    const updates: LockableMap = {
      [folderPath]: {
        type: folder.type,
        isLocked: false,
      },
    };

    const folderPrefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
    Object.entries(currentFiles).forEach(([path, file]) => {
      if (path.startsWith(folderPrefix) && file && file.lockedByFolder === folderPath) {
        updates[path] = {
          ...file,
          isLocked: false,
          lockedByFolder: undefined,
        };
      }
    });

    this._deps.setFiles({ ...currentFiles, ...updates });
    removeLockedFolder(currentChatId, folderPath);
    this._deps.logInfo(`Folder unlocked: ${folderPath} for chat: ${currentChatId}`);

    return true;
  }
}
