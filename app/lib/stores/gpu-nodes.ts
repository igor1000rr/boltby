/**
 * GPU Nodes Store
 *
 * Manages GPU compute nodes (Ollama/LMStudio endpoints) that can be shared
 * between users on the same Boltby instance.
 *
 * Storage: Appwrite `gpu_nodes` collection (shared) + localStorage (fallback/cache)
 * Integration: Sets Ollama provider baseUrl when user selects a node
 */

import { atom } from 'nanostores';
import { createScopedLogger } from '~/utils/logger';
import { appwriteUser, getDatabases, DATABASE_ID, ID, Query } from '~/lib/stores/appwrite';
import { Permission, Role } from 'appwrite';
import { updateProviderSettings } from '~/lib/stores/settings';

const logger = createScopedLogger('GpuNodes');

const GPU_NODES_COLLECTION = 'gpu_nodes';
const LOCAL_STORAGE_KEY = 'gpu_nodes_cache';
const ACTIVE_NODE_KEY = 'gpu_active_node';

export interface GpuNode {
  id: string;
  name: string;
  host: string;
  port: string;
  provider: 'ollama' | 'lmstudio';
  addedBy: string;
  addedByName: string;
  isPublic: boolean;
  status: 'online' | 'offline' | 'unknown';
  latency: number;
  modelCount: number;
  lastChecked: string;
  createdAt: string;
}

export const gpuNodes = atom<GpuNode[]>([]);
export const activeNodeId = atom<string | null>(null);
export const gpuNodesLoading = atom<boolean>(false);

// ─── Active Node ───

export function getActiveNode(): GpuNode | null {
  const id = activeNodeId.get();

  if (!id) {
    return null;
  }

  return gpuNodes.get().find((n) => n.id === id) || null;
}

export function setActiveNode(nodeId: string | null) {
  activeNodeId.set(nodeId);

  if (typeof window !== 'undefined') {
    if (nodeId) {
      localStorage.setItem(ACTIVE_NODE_KEY, nodeId);
    } else {
      localStorage.removeItem(ACTIVE_NODE_KEY);
    }
  }

  // Update Ollama provider baseUrl in provider_settings
  const node = nodeId ? gpuNodes.get().find((n) => n.id === nodeId) : null;
  updateProviderBaseUrl(node);
}

function updateProviderBaseUrl(node: GpuNode | null | undefined) {
  if (typeof window === 'undefined') {
    return;
  }

  const providerName = node?.provider === 'lmstudio' ? 'LMStudio' : 'Ollama';

  if (node) {
    const proto = node.host.startsWith('http') ? '' : 'http://';
    const hostPart = node.host.replace(/\/+$/, '');

    // Avoid double port: if host already has :port, use as-is
    const baseUrl = hostPart.match(/:\d+$/) ? `${proto}${hostPart}` : `${proto}${hostPart}:${node.port}`;

    // Update in-memory store → triggers useSettings → writes cookie for server
    updateProviderSettings(providerName, { enabled: true, baseUrl } as any);

    logger.debug(`Active GPU node → ${providerName} baseUrl: ${baseUrl}`);
  } else {
    // Clear custom baseUrl — revert to env default
    updateProviderSettings(providerName, { baseUrl: undefined } as any);

    logger.debug(`GPU node deactivated, ${providerName} reverted to default`);
  }
}

// ─── Init ───

export function initGpuNodes() {
  // Restore active node from localStorage
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem(ACTIVE_NODE_KEY);

    if (saved) {
      activeNodeId.set(saved);
    }
  }

  // Load from cache immediately, then refresh from Appwrite
  loadFromCache();
  loadFromAppwrite().catch(() => {});
}

// ─── Local Cache ───

function loadFromCache() {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const cached = localStorage.getItem(LOCAL_STORAGE_KEY);

    if (cached) {
      gpuNodes.set(JSON.parse(cached));
    }
  } catch {
    // ignore
  }
}

function saveToCache(nodes: GpuNode[]) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(nodes));
  } catch {
    // ignore
  }
}

// ─── Appwrite CRUD ───

function isAppwriteReady(): boolean {
  return appwriteUser.get() !== null;
}

function getUserId(): string {
  return appwriteUser.get()?.$id || 'local';
}

function getUserName(): string {
  return appwriteUser.get()?.name || appwriteUser.get()?.email || 'Anonymous';
}

export async function loadFromAppwrite(): Promise<void> {
  if (!isAppwriteReady()) {
    return;
  }

  gpuNodesLoading.set(true);

  try {
    const db = getDatabases();
    const userId = getUserId();

    // Fetch: own nodes + public nodes from others
    const result = await db.listDocuments(DATABASE_ID, GPU_NODES_COLLECTION, [
      Query.limit(100),
      Query.orderDesc('$createdAt'),
    ]);

    const nodes: GpuNode[] = result.documents
      .filter((doc) => doc.addedBy === userId || doc.isPublic === 'true' || doc.isPublic === true)
      .map((doc) => ({
        id: doc.$id,
        name: doc.name || '',
        host: doc.host || '',
        port: doc.port || '11434',
        provider: (doc.provider as 'ollama' | 'lmstudio') || 'ollama',
        addedBy: doc.addedBy || '',
        addedByName: doc.addedByName || '',
        isPublic: doc.isPublic === 'true' || doc.isPublic === true,
        status: 'unknown' as const,
        latency: 0,
        modelCount: 0,
        lastChecked: '',
        createdAt: doc.$createdAt || '',
      }));

    gpuNodes.set(nodes);
    saveToCache(nodes);
  } catch (error) {
    logger.warn('Failed to load GPU nodes from Appwrite:', error);
  } finally {
    gpuNodesLoading.set(false);
  }
}

export async function addNode(
  node: Omit<
    GpuNode,
    'id' | 'addedBy' | 'addedByName' | 'status' | 'latency' | 'modelCount' | 'lastChecked' | 'createdAt'
  >,
): Promise<GpuNode | null> {
  const userId = getUserId();
  const userName = getUserName();

  const newNode: GpuNode = {
    ...node,
    id: '',
    addedBy: userId,
    addedByName: userName,
    status: 'unknown',
    latency: 0,
    modelCount: 0,
    lastChecked: '',
    createdAt: new Date().toISOString(),
  };

  if (isAppwriteReady()) {
    try {
      const db = getDatabases();
      const perms = [
        Permission.read(Role.users()),
        Permission.update(Role.user(userId)),
        Permission.delete(Role.user(userId)),
      ];

      const doc = await db.createDocument(
        DATABASE_ID,
        GPU_NODES_COLLECTION,
        ID.unique(),
        {
          name: node.name,
          host: node.host,
          port: node.port,
          provider: node.provider,
          addedBy: userId,
          addedByName: userName,
          isPublic: node.isPublic ? 'true' : 'false',
        },
        perms,
      );

      newNode.id = doc.$id;
    } catch (error) {
      logger.warn('Failed to save node to Appwrite:', error);
      newNode.id = `local_${Date.now()}`;
    }
  } else {
    newNode.id = `local_${Date.now()}`;
  }

  const updated = [...gpuNodes.get(), newNode];
  gpuNodes.set(updated);
  saveToCache(updated);

  return newNode;
}

export async function removeNode(nodeId: string): Promise<void> {
  if (isAppwriteReady() && !nodeId.startsWith('local_')) {
    try {
      const db = getDatabases();
      await db.deleteDocument(DATABASE_ID, GPU_NODES_COLLECTION, nodeId);
    } catch (error) {
      logger.warn('Failed to delete node from Appwrite:', error);
    }
  }

  // Clear active if this was it
  if (activeNodeId.get() === nodeId) {
    setActiveNode(null);
  }

  const updated = gpuNodes.get().filter((n) => n.id !== nodeId);
  gpuNodes.set(updated);
  saveToCache(updated);
}

export async function updateNode(
  nodeId: string,
  updates: Partial<Pick<GpuNode, 'name' | 'host' | 'port' | 'provider' | 'isPublic'>>,
): Promise<void> {
  if (isAppwriteReady() && !nodeId.startsWith('local_')) {
    try {
      const db = getDatabases();
      const data: Record<string, string> = {};

      if (updates.name !== undefined) {
        data.name = updates.name;
      }

      if (updates.host !== undefined) {
        data.host = updates.host;
      }

      if (updates.port !== undefined) {
        data.port = updates.port;
      }

      if (updates.provider !== undefined) {
        data.provider = updates.provider;
      }

      if (updates.isPublic !== undefined) {
        data.isPublic = updates.isPublic ? 'true' : 'false';
      }

      await db.updateDocument(DATABASE_ID, GPU_NODES_COLLECTION, nodeId, data);
    } catch (error) {
      logger.warn('Failed to update node in Appwrite:', error);
    }
  }

  const nodes = gpuNodes.get().map((n) => (n.id === nodeId ? { ...n, ...updates } : n));
  gpuNodes.set(nodes);
  saveToCache(nodes);

  // Update active node baseUrl if this is the active one
  if (activeNodeId.get() === nodeId) {
    const updated = nodes.find((n) => n.id === nodeId);
    updateProviderBaseUrl(updated || null);
  }
}

// ─── Health Check ───

export async function checkNode(nodeId: string): Promise<GpuNode | null> {
  const node = gpuNodes.get().find((n) => n.id === nodeId);

  if (!node) {
    return null;
  }

  try {
    const resp = await fetch(
      `/api/gpu-nodes?action=check&host=${encodeURIComponent(node.host)}&port=${encodeURIComponent(node.port)}`,
    );
    const data = (await resp.json()) as { ok: boolean; latency?: number; modelCount?: number; error?: string };

    const updated: Partial<GpuNode> = {
      status: data.ok ? 'online' : 'offline',
      latency: data.latency || 0,
      modelCount: data.modelCount || 0,
      lastChecked: new Date().toISOString(),
    };

    const nodes = gpuNodes.get().map((n) => (n.id === nodeId ? { ...n, ...updated } : n));
    gpuNodes.set(nodes);
    saveToCache(nodes);

    return nodes.find((n) => n.id === nodeId) || null;
  } catch {
    const nodes = gpuNodes
      .get()
      .map((n) => (n.id === nodeId ? { ...n, status: 'offline' as const, lastChecked: new Date().toISOString() } : n));
    gpuNodes.set(nodes);
    saveToCache(nodes);

    return nodes.find((n) => n.id === nodeId) || null;
  }
}

export async function checkAllNodes(): Promise<void> {
  const nodes = gpuNodes.get();

  await Promise.allSettled(nodes.map((n) => checkNode(n.id)));
}

// ─── Model Listing ───

export interface GpuNodeModel {
  name: string;
  size: number;
  sizeGB: string;
  parameterSize: string;
  family: string;
  quantization: string;
}

export async function getNodeModels(nodeId: string): Promise<GpuNodeModel[]> {
  const node = gpuNodes.get().find((n) => n.id === nodeId);

  if (!node) {
    return [];
  }

  try {
    const resp = await fetch(
      `/api/gpu-nodes?action=models&host=${encodeURIComponent(node.host)}&port=${encodeURIComponent(node.port)}`,
    );
    const data = (await resp.json()) as { ok: boolean; models?: GpuNodeModel[] };

    return data.ok ? data.models || [] : [];
  } catch {
    return [];
  }
}

/**
 * Trigger model pull on a remote GPU node (through VPS proxy).
 */
export async function pullModelOnNode(nodeId: string, modelName: string): Promise<{ ok: boolean; message?: string }> {
  const node = gpuNodes.get().find((n) => n.id === nodeId);

  if (!node) {
    return { ok: false, message: 'Node not found' };
  }

  try {
    const resp = await fetch(
      `/api/gpu-nodes?action=pull&host=${encodeURIComponent(node.host)}&port=${encodeURIComponent(node.port)}&model=${encodeURIComponent(modelName)}`,
    );
    return (await resp.json()) as { ok: boolean; message?: string };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
}

/**
 * Poll pull progress on a remote GPU node.
 */
export async function getPullStatus(
  nodeId: string,
  modelName: string,
): Promise<{ status: string; percent: number; done: boolean; error: string } | null> {
  const node = gpuNodes.get().find((n) => n.id === nodeId);

  if (!node) {
    return null;
  }

  try {
    const resp = await fetch(
      `/api/gpu-nodes?action=pull-status&host=${encodeURIComponent(node.host)}&port=${encodeURIComponent(node.port)}&model=${encodeURIComponent(modelName)}`,
    );
    const data = (await resp.json()) as { ok: boolean; job?: any };

    return data.job || null;
  } catch {
    return null;
  }
}

// ─── Setup Token & Auto-Registration ───

export function generateSetupToken(): string {
  const userId = getUserId();
  const userName = getUserName();

  // Boltby URL = current origin
  const boltbyUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const payload = {
    uid: userId,
    name: userName,
    url: boltbyUrl,
    ts: Date.now(),
  };

  return btoa(JSON.stringify(payload));
}

export function getSetupCommand(): string {
  const token = generateSetupToken();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return `curl -fsSL '${origin}/api/gpu-setup?token=${token}' | sudo bash`;
}

/**
 * Poll for auto-registered nodes (from gpu-setup script).
 * Called periodically after user generates a setup command.
 */
export async function pollPendingNodes(): Promise<number> {
  const userId = getUserId();

  if (!userId) {
    return 0;
  }

  try {
    const resp = await fetch(`/api/gpu-nodes?action=pending&userId=${encodeURIComponent(userId)}`);
    const data = (await resp.json()) as { ok: boolean; nodes?: any[] };

    if (!data.ok || !data.nodes || data.nodes.length === 0) {
      return 0;
    }

    let added = 0;

    for (const pending of data.nodes) {
      const node = await addNode({
        name: pending.name || 'GPU Node',
        host: pending.host,
        port: pending.port || '11434',
        provider: 'ollama',
        isPublic: pending.isPublic !== false,
      });

      if (node) {
        // Auto-check the new node
        checkNode(node.id);
        added++;
      }
    }

    return added;
  } catch {
    return 0;
  }
}
