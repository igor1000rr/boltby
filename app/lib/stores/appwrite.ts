import { atom } from 'nanostores';
import { Client, Account, Databases, ID, Query, Permission, Role } from 'appwrite';
import type { Models } from 'appwrite';

// === Connection State ===

export interface AppwriteConnectionState {
  endpoint: string;
  projectId: string;
  isConnected: boolean;
  status: 'checking' | 'connected' | 'disconnected';
}

const DEFAULT_ENDPOINT = import.meta.env.VITE_APPWRITE_ENDPOINT || '';
const DEFAULT_PROJECT_ID = import.meta.env.VITE_APPWRITE_PROJECT_ID || '';
const DATABASE_ID = import.meta.env.VITE_APPWRITE_DATABASE_ID || 'boltby_platform';

export const appwriteConnection = atom<AppwriteConnectionState>({
  endpoint: DEFAULT_ENDPOINT,
  projectId: DEFAULT_PROJECT_ID,
  isConnected: false,
  status: 'checking',
});

export const appwriteUser = atom<Models.User<Models.Preferences> | null>(null);

// === Appwrite Client Singleton ===

let client: Client | null = null;
let account: Account | null = null;
let databases: Databases | null = null;

export function getClient(): Client {
  if (!client) {
    const state = appwriteConnection.get();
    client = new Client();

    if (state.endpoint && state.projectId) {
      client.setEndpoint(state.endpoint).setProject(state.projectId);
    }
  }

  return client;
}

export function getAccount(): Account {
  if (!account) {
    account = new Account(getClient());
  }

  return account;
}

export function getDatabases(): Databases {
  if (!databases) {
    databases = new Databases(getClient());
  }

  return databases;
}

function resetClient() {
  client = null;
  account = null;
  databases = null;
}

// === Connection Management ===

export async function checkAppwriteHealth(endpoint?: string, projectId?: string): Promise<boolean> {
  const ep = endpoint || appwriteConnection.get().endpoint;
  const pid = projectId || appwriteConnection.get().projectId;

  if (!ep || !pid) {
    return false;
  }

  try {
    const resp = await fetch(`${ep}/health`, { signal: AbortSignal.timeout(5000) });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function initAppwriteConnection() {
  const savedEndpoint = typeof window !== 'undefined' ? localStorage.getItem('appwrite_endpoint') : null;
  const savedProjectId = typeof window !== 'undefined' ? localStorage.getItem('appwrite_project_id') : null;

  const endpoint = savedEndpoint || DEFAULT_ENDPOINT;
  const projectId = savedProjectId || DEFAULT_PROJECT_ID;

  if (!endpoint || !projectId) {
    appwriteConnection.set({ endpoint, projectId, isConnected: false, status: 'disconnected' });
    return;
  }

  appwriteConnection.set({ endpoint, projectId, isConnected: false, status: 'checking' });

  // Reinitialize client with saved config
  resetClient();
  const c = getClient();
  c.setEndpoint(endpoint).setProject(projectId);

  const ok = await checkAppwriteHealth(endpoint, projectId);
  appwriteConnection.set({ endpoint, projectId, isConnected: ok, status: ok ? 'connected' : 'disconnected' });

  // Try to restore session
  if (ok) {
    try {
      const acc = getAccount();
      const user = await acc.get();
      appwriteUser.set(user);
    } catch {
      appwriteUser.set(null);
    }
  }
}

export function setAppwriteConfig(endpoint: string, projectId: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('appwrite_endpoint', endpoint);
    localStorage.setItem('appwrite_project_id', projectId);
  }

  resetClient();
  const c = getClient();
  c.setEndpoint(endpoint).setProject(projectId);

  appwriteConnection.set({ endpoint, projectId, isConnected: false, status: 'checking' });

  checkAppwriteHealth(endpoint, projectId)
    .then((ok) => {
      appwriteConnection.set({ endpoint, projectId, isConnected: ok, status: ok ? 'connected' : 'disconnected' });
    })
    .catch(() => {
      appwriteConnection.set({ endpoint, projectId, isConnected: false, status: 'disconnected' });
    });
}

// === Auth ===

export async function signUp(email: string, password: string, name?: string): Promise<Models.User<Models.Preferences>> {
  const acc = getAccount();
  await acc.create(ID.unique(), email, password, name);
  await acc.createEmailPasswordSession(email, password);

  const user = await acc.get();
  appwriteUser.set(user);

  return user;
}

export async function signIn(email: string, password: string): Promise<Models.User<Models.Preferences>> {
  const acc = getAccount();
  await acc.createEmailPasswordSession(email, password);

  const user = await acc.get();
  appwriteUser.set(user);

  return user;
}

export async function signOut(): Promise<void> {
  const acc = getAccount();
  await acc.deleteSession('current');
  appwriteUser.set(null);
}

export async function getCurrentUser(): Promise<Models.User<Models.Preferences> | null> {
  try {
    const acc = getAccount();
    const user = await acc.get();
    appwriteUser.set(user);

    return user;
  } catch {
    appwriteUser.set(null);
    return null;
  }
}

// === Site Database (for AI-generated sites) ===

export async function createSiteDatabase(name: string): Promise<Models.Document> {
  const db = getDatabases();
  const user = appwriteUser.get();
  const perms = user
    ? [
        Permission.read(Role.user(user.$id)),
        Permission.update(Role.user(user.$id)),
        Permission.delete(Role.user(user.$id)),
      ]
    : [];

  return db.createDocument(
    DATABASE_ID,
    'site_databases',
    ID.unique(),
    {
      userId: user?.$id || '',
      name,
      createdAt: new Date().toISOString(),
    },
    perms,
  );
}

export { ID, Query, DATABASE_ID };

/**
 * Get the current Appwrite endpoint URL (for UI components like ServiceStatus).
 * Checks: localStorage override → VITE env → empty string.
 */
export function getAppwriteEndpoint(): string {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('appwrite_endpoint');

    if (saved) {
      return saved;
    }
  }

  return DEFAULT_ENDPOINT;
}
