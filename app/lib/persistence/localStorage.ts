import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('LocalStorage');
const isClient = typeof window !== 'undefined' && typeof localStorage !== 'undefined';

export function getLocalStorage<T = unknown>(key: string): T | null {
  if (!isClient) {
    return null;
  }

  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : null;
  } catch (error) {
    logger.error(`Error reading key "${key}":`, error);
    return null;
  }
}

export function setLocalStorage(key: string, value: unknown): void {
  if (!isClient) {
    return;
  }

  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    logger.error(`Error writing key "${key}":`, error);
  }
}
