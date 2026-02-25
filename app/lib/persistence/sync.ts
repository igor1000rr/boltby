/**
 * Sync layer: IndexedDB (primary, fast, offline) ↔ Appwrite (cloud, cross-device)
 *
 * Strategy:
 * - IndexedDB is always the source of truth for the current session
 * - After every local write, async mirror to Appwrite (non-blocking)
 * - On login, pull remote chats that don't exist locally → merge into IndexedDB
 * - Deletes are mirrored to cloud
 * - All cloud operations are fire-and-forget: never block UI on cloud errors
 *
 * v2 fixes:
 * - Document IDs are namespaced per user to avoid collisions
 * - Messages are chunked if > MAX_CONTENT_SIZE
 * - Pull uses cursor pagination (no 200 limit)
 * - Basic retry with exponential backoff
 * - Timestamp-based conflict resolution on pull
 */

import { createScopedLogger } from '~/utils/logger';
import { appwriteUser, getDatabases, DATABASE_ID, Query } from '~/lib/stores/appwrite';
import { Permission, Role } from 'appwrite';
import type { Message } from 'ai';
import type { IChatMetadata } from './db';
import { openDatabase, setMessages as idbSetMessages, getAll } from './db';

const logger = createScopedLogger('CloudSync');

const CHATS_COLLECTION = 'conversations';
const MESSAGES_COLLECTION = 'messages';
const SNAPSHOTS_COLLECTION = 'snapshots';

// Appwrite string attribute is set to 1,000,000 chars in deploy script.
// Leave margin for JSON overhead.
const MAX_CONTENT_SIZE = 950_000;
const MAX_RETRIES = 3;
const PAGE_SIZE = 100;

// ─── Retry Queue ───

interface QueueItem {
  fn: () => Promise<void>;
  retries: number;
  chatId: string;
}

const retryQueue: QueueItem[] = [];
let queueRunning = false;

async function processQueue() {
  if (queueRunning) {
    return;
  }

  queueRunning = true;

  while (retryQueue.length > 0) {
    const item = retryQueue.shift()!;

    try {
      await item.fn();
    } catch (error) {
      if (item.retries < MAX_RETRIES) {
        item.retries++;

        const delay = Math.min(1000 * Math.pow(2, item.retries), 10000);
        logger.debug(`Retry ${item.retries}/${MAX_RETRIES} for chat ${item.chatId} in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        retryQueue.push(item);
      } else {
        logger.warn(`Gave up syncing chat ${item.chatId} after ${MAX_RETRIES} retries`);
      }
    }
  }

  queueRunning = false;
}

// ─── Helpers ───

function getUserId(): string | null {
  const user = appwriteUser.get();
  return user?.$id || null;
}

function isCloudAvailable(): boolean {
  return getUserId() !== null;
}

function getUserPermissions(): string[] {
  const uid = getUserId();

  if (!uid) {
    return [];
  }

  return [
    Permission.read(Role.user(uid)),
    Permission.update(Role.user(uid)),
    Permission.delete(Role.user(uid)),
  ];
}

/**
 * Build a globally unique cloud document ID for a conversation.
 * Format: `{userId}_{localChatId}` — max 36 chars (Appwrite limit).
 * userId is typically 20 chars, chatId is typically 1-6 chars.
 */
function cloudDocId(userId: string, localChatId: string): string {
  // Appwrite doc IDs: ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$
  const id = `${userId}_${localChatId}`;

  if (id.length > 36) {
    // Safety: truncate userId if combined ID too long
    return `${userId.slice(0, 36 - localChatId.length - 1)}_${localChatId}`;
  }

  return id;
}

/**
 * Build cloud document ID for a message chunk.
 * Format: `m{userId_last8}_{localChatId}_{chunkIndex}`
 */
function cloudMsgDocId(userId: string, localChatId: string, chunkIndex: number): string {
  const uid = userId.slice(-10);
  const id = `m${uid}_${localChatId}_${chunkIndex}`;

  if (id.length > 36) {
    return `m${uid.slice(-6)}_${localChatId}_${chunkIndex}`;
  }

  return id;
}

/**
 * Serialize messages, chunking if necessary.
 * Returns array of string chunks, each under MAX_CONTENT_SIZE.
 */
function serializeMessages(messages: Message[]): string[] {
  const serialized = JSON.stringify(
    messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      annotations: m.annotations,
    })),
  );

  if (serialized.length <= MAX_CONTENT_SIZE) {
    return [serialized];
  }

  // Content too large — chunk it
  const chunks: string[] = [];

  for (let i = 0; i < serialized.length; i += MAX_CONTENT_SIZE) {
    chunks.push(serialized.substring(i, i + MAX_CONTENT_SIZE));
  }

  logger.debug(`Messages serialized to ${chunks.length} chunks (${serialized.length} chars total)`);

  return chunks;
}

/**
 * Reassemble chunked message content back to Message[].
 */
function deserializeChunks(chunks: string[]): Message[] {
  const combined = chunks.join('');

  return JSON.parse(combined);
}

// ─── Sync To Cloud ───

async function doSyncChatToCloud(
  chatId: string,
  messages: Message[],
  urlId?: string,
  description?: string,
  metadata?: IChatMetadata,
): Promise<void> {
  const userId = getUserId()!;
  const db = getDatabases();
  const docId = cloudDocId(userId, chatId);
  const now = new Date().toISOString();
  const chunks = serializeMessages(messages);

  // 1. Upsert conversation document
  const convData = {
    userId,
    localChatId: chatId,
    urlId: urlId || '',
    description: description || '',
    metadata: metadata ? JSON.stringify(metadata) : '',
    chunkCount: String(chunks.length),
    updatedAt: now,
  };

  try {
    await db.getDocument(DATABASE_ID, CHATS_COLLECTION, docId);

    // Exists → update (no userId/createdAt change)
    const { userId: _u, ...updateData } = convData;
    await db.updateDocument(DATABASE_ID, CHATS_COLLECTION, docId, updateData);
  } catch {
    // Doesn't exist → create
    await db.createDocument(
      DATABASE_ID,
      CHATS_COLLECTION,
      docId,
      { ...convData, createdAt: now },
      getUserPermissions(),
    );
  }

  // 2. Write message chunks
  for (let i = 0; i < chunks.length; i++) {
    const msgDocId = cloudMsgDocId(userId, chatId, i);
    const msgData = {
      conversationId: docId,
      content: chunks[i],
      role: 'bulk',
      messageId: `chunk_${i}`,
      annotations: '',
      createdAt: now,
    };

    try {
      await db.getDocument(DATABASE_ID, MESSAGES_COLLECTION, msgDocId);
      await db.updateDocument(DATABASE_ID, MESSAGES_COLLECTION, msgDocId, {
        content: chunks[i],
        createdAt: now,
      });
    } catch {
      await db.createDocument(DATABASE_ID, MESSAGES_COLLECTION, msgDocId, msgData, getUserPermissions());
    }
  }

  // 3. Clean up old chunks if chunk count decreased
  // Try to delete chunk indices beyond current count (best effort)
  for (let i = chunks.length; i < chunks.length + 5; i++) {
    try {
      await db.deleteDocument(DATABASE_ID, MESSAGES_COLLECTION, cloudMsgDocId(userId, chatId, i));
    } catch {
      break; // No more old chunks
    }
  }

  logger.debug(`Synced chat ${chatId} → ${docId} (${chunks.length} chunks)`);
}

export async function syncChatToCloud(
  chatId: string,
  messages: Message[],
  urlId?: string,
  description?: string,
  metadata?: IChatMetadata,
): Promise<void> {
  if (!isCloudAvailable()) {
    return;
  }

  try {
    await doSyncChatToCloud(chatId, messages, urlId, description, metadata);
  } catch (error) {
    logger.warn(`Cloud sync failed for ${chatId}, queuing retry:`, error);
    retryQueue.push({
      fn: () => doSyncChatToCloud(chatId, messages, urlId, description, metadata),
      retries: 0,
      chatId,
    });
    processQueue();
  }
}

// ─── Delete From Cloud ───

export async function syncDeleteToCloud(chatId: string): Promise<void> {
  if (!isCloudAvailable()) {
    return;
  }

  const userId = getUserId()!;
  const docId = cloudDocId(userId, chatId);

  try {
    const db = getDatabases();

    // Delete all message chunks (try up to 20)
    for (let i = 0; i < 20; i++) {
      try {
        await db.deleteDocument(DATABASE_ID, MESSAGES_COLLECTION, cloudMsgDocId(userId, chatId, i));
      } catch {
        break;
      }
    }

    // Also try legacy message doc ID (migration from v1)
    try {
      await db.deleteDocument(DATABASE_ID, MESSAGES_COLLECTION, `msg_${chatId}`);
    } catch {
      // ignore
    }

    // Delete snapshot
    try {
      await db.deleteDocument(DATABASE_ID, SNAPSHOTS_COLLECTION, docId);
    } catch {
      // ignore
    }

    // Delete conversation
    try {
      await db.deleteDocument(DATABASE_ID, CHATS_COLLECTION, docId);
    } catch {
      // ignore
    }

    // Also try legacy conversation doc ID (migration from v1)
    try {
      await db.deleteDocument(DATABASE_ID, CHATS_COLLECTION, chatId);
    } catch {
      // ignore
    }

    logger.debug(`Deleted chat ${chatId} from cloud`);
  } catch (error) {
    logger.warn('Cloud delete failed (non-blocking):', error);
  }
}

// ─── Pull From Cloud (on login) ───

export async function pullFromCloud(): Promise<number> {
  if (!isCloudAvailable()) {
    return 0;
  }

  const userId = getUserId()!;

  try {
    const idb = await openDatabase();

    if (!idb) {
      return 0;
    }

    const appwriteDb = getDatabases();

    // Get all local chat data (id + updatedAt for conflict resolution)
    const localChats = await getAll(idb);
    const localMap = new Map(localChats.map((c) => [c.id, c]));

    let imported = 0;
    let cursor: string | undefined;

    // Paginated fetch of all remote conversations
    while (true) {
      const queries = [
        Query.equal('userId', userId),
        Query.limit(PAGE_SIZE),
        Query.orderDesc('updatedAt'),
      ];

      if (cursor) {
        queries.push(Query.cursorAfter(cursor));
      }

      const page = await appwriteDb.listDocuments(DATABASE_ID, CHATS_COLLECTION, queries);

      if (page.documents.length === 0) {
        break;
      }

      for (const doc of page.documents) {
        // Extract local chat ID from document
        const localChatId = doc.localChatId || doc.$id;
        const localChat = localMap.get(localChatId);

        // Skip if local version is newer (conflict resolution)
        if (localChat && localChat.timestamp) {
          const localTime = new Date(localChat.timestamp).getTime();
          const cloudTime = new Date(doc.updatedAt || doc.$createdAt).getTime();

          if (localTime >= cloudTime) {
            continue;
          }
        } else if (localChat) {
          // Local exists but no timestamp — skip (don't overwrite)
          continue;
        }

        // Fetch message chunks
        try {
          const chunkCount = parseInt(doc.chunkCount || '1', 10);
          const chunks: string[] = [];

          for (let i = 0; i < chunkCount; i++) {
            try {
              const msgDoc = await appwriteDb.getDocument(
                DATABASE_ID,
                MESSAGES_COLLECTION,
                cloudMsgDocId(userId, localChatId, i),
              );
              chunks.push(msgDoc.content || '');
            } catch {
              // Try legacy doc ID (v1 migration)
              if (i === 0) {
                try {
                  const legacyDoc = await appwriteDb.getDocument(
                    DATABASE_ID,
                    MESSAGES_COLLECTION,
                    `msg_${localChatId}`,
                  );
                  chunks.push(legacyDoc.content || '');
                } catch {
                  // No messages at all
                }
              }

              break;
            }
          }

          if (chunks.length === 0) {
            continue;
          }

          let messages: Message[];

          try {
            messages = deserializeChunks(chunks);
          } catch {
            logger.warn(`Failed to parse messages for ${localChatId}`);
            continue;
          }

          if (messages.length === 0) {
            continue;
          }

          // Parse metadata
          let parsedMetadata: IChatMetadata | undefined;

          try {
            if (doc.metadata) {
              parsedMetadata = JSON.parse(doc.metadata);
            }
          } catch {
            // ignore
          }

          // Write to IndexedDB
          await idbSetMessages(
            idb,
            localChatId,
            messages,
            doc.urlId || undefined,
            doc.description || undefined,
            doc.updatedAt,
            parsedMetadata,
          );

          imported++;
          logger.debug(`Imported cloud chat: ${doc.description || localChatId}`);
        } catch (err) {
          logger.warn(`Failed to import chat ${localChatId}:`, err);
        }
      }

      // Set cursor for next page
      cursor = page.documents[page.documents.length - 1].$id;

      // If we got less than PAGE_SIZE, we've reached the end
      if (page.documents.length < PAGE_SIZE) {
        break;
      }
    }

    if (imported > 0) {
      logger.debug(`Imported ${imported} chats from cloud`);
    }

    return imported;
  } catch (error) {
    logger.warn('Pull from cloud failed:', error);
    return 0;
  }
}

// ─── Push All Local To Cloud ───

export async function pushAllToCloud(): Promise<number> {
  if (!isCloudAvailable()) {
    return 0;
  }

  try {
    const idb = await openDatabase();

    if (!idb) {
      return 0;
    }

    const localChats = await getAll(idb);
    let pushed = 0;

    for (const chat of localChats) {
      if (chat.messages && chat.messages.length > 0) {
        await syncChatToCloud(chat.id, chat.messages, chat.urlId, chat.description, chat.metadata);
        pushed++;
      }
    }

    if (pushed > 0) {
      logger.debug(`Pushed ${pushed} local chats to cloud`);
    }

    return pushed;
  } catch (error) {
    logger.warn('Push to cloud failed:', error);
    return 0;
  }
}

// ─── Full Bidirectional Sync ───

export async function fullSync(): Promise<{ pulled: number; pushed: number }> {
  const pulled = await pullFromCloud();
  const pushed = await pushAllToCloud();

  return { pulled, pushed };
}
