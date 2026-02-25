import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ResourceManager');

interface OllamaPsModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  expires_at: string;
}

interface LMStudioModelInfo {
  key: string;
  type: string;
  max_context_length?: number;
  loaded_instances: Array<{
    id: string;
    config: { context_length: number };
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Promise-based async mutex. Serializes access to a critical section
 * so that only one caller runs at a time; others queue up.
 */
class AsyncMutex {
  private _chain: Promise<void> = Promise.resolve();
  private _locked = false;
  private _queueSize = 0;

  get locked(): boolean {
    return this._locked;
  }

  get waiting(): number {
    return this._queueSize;
  }

  acquire<T>(fn: () => Promise<T>): Promise<T> {
    this._queueSize++;

    const next = this._chain.then(async () => {
      this._locked = true;
      this._queueSize--;

      try {
        return await fn();
      } finally {
        this._locked = false;
      }
    });

    /* Detach the returned promise from the queue chain so errors in one caller don't break subsequent ones. */
    this._chain = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  }
}

class ResourceManager {
  private static _instance: ResourceManager;

  private _activeProvider: string | null = null;
  private _activeModel: string | null = null;
  private readonly _gpuMutex = new AsyncMutex();

  static getInstance(): ResourceManager {
    if (!ResourceManager._instance) {
      ResourceManager._instance = new ResourceManager();
    }

    return ResourceManager._instance;
  }

  get gpuLocked(): boolean {
    return this._gpuMutex.locked;
  }

  get gpuQueueSize(): number {
    return this._gpuMutex.waiting;
  }

  private _getOllamaUrl(): string {
    return process?.env?.OLLAMA_API_BASE_URL || 'http://127.0.0.1:11434';
  }

  private _getLMStudioUrl(): string {
    return process?.env?.LMSTUDIO_API_BASE_URL || 'http://127.0.0.1:1234';
  }

  async isOllamaReachable(baseUrl?: string): Promise<boolean> {
    try {
      const url = baseUrl || this._getOllamaUrl();
      const resp = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(3000) });

      return resp.ok;
    } catch {
      return false;
    }
  }

  async isLMStudioReachable(baseUrl?: string): Promise<boolean> {
    try {
      const url = baseUrl || this._getLMStudioUrl();
      const resp = await fetch(`${url}/api/v1/models`, { signal: AbortSignal.timeout(3000) });

      return resp.ok;
    } catch {
      return false;
    }
  }

  private async _unloadAllOllama(baseUrl: string): Promise<number> {
    let count = 0;

    try {
      const psResp = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(5000) });
      const psData = (await psResp.json()) as { models: OllamaPsModel[] };

      for (const loaded of psData.models || []) {
        logger.info(`[UNLOAD] Ollama: ${loaded.name} (${(loaded.size / 1e9).toFixed(1)} GB)`);

        await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: loaded.name, prompt: '', keep_alive: 0, options: { num_predict: 0 } }),
        });

        await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: loaded.name, messages: [], keep_alive: 0 }),
        }).catch((err) => {
          logger.debug('[UNLOAD] Ollama chat unload request failed:', err instanceof Error ? err.message : String(err));
        });
        count++;
      }

      if (count > 0) {
        logger.info(`[UNLOAD] Ollama: sent unload for ${count} model(s), waiting for GPU release...`);

        const freed = await this._waitForOllamaUnload(baseUrl);

        if (freed) {
          logger.info(`[UNLOAD] Ollama: GPU memory freed`);
        } else {
          logger.warn(`[UNLOAD] Ollama: timeout waiting for GPU release, forcing continue`);
        }
      }
    } catch {
      logger.debug('[UNLOAD] Ollama: server not reachable');
    }

    return count;
  }

  private async _waitForOllamaUnload(baseUrl: string, keepModel?: string, timeoutMs: number = 15000): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(3000) });
        const data = (await resp.json()) as { models: OllamaPsModel[] };
        const stillLoaded = (data.models || []).filter((m) => m.name !== keepModel);

        if (stillLoaded.length === 0) {
          return true;
        }

        logger.debug(
          `[WAIT] Ollama: ${stillLoaded.length} model(s) still in VRAM (${((Date.now() - start) / 1000).toFixed(1)}s)`,
        );
      } catch (err) {
        logger.debug(
          '[WAIT] Ollama unreachable during poll, assuming unloaded:',
          err instanceof Error ? err.message : String(err),
        );
        return true;
      }

      await sleep(500);
    }

    return false;
  }

  private async _unloadAllLMStudio(baseUrl: string): Promise<number> {
    let count = 0;

    try {
      const resp = await fetch(`${baseUrl}/api/v1/models`, { signal: AbortSignal.timeout(5000) });
      const data = (await resp.json()) as { models: LMStudioModelInfo[] };

      for (const m of data.models || []) {
        if (m.type !== 'llm' || !m.loaded_instances?.length) {
          continue;
        }

        for (const inst of m.loaded_instances) {
          logger.info(`[UNLOAD] LMStudio: ${m.key} (ctx=${inst.config.context_length})`);

          await fetch(`${baseUrl}/api/v1/models/unload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instance_id: inst.id }),
          });
          count++;
        }
      }

      if (count > 0) {
        logger.info(`[UNLOAD] LMStudio: sent unload for ${count} model(s), waiting for GPU release...`);

        const freed = await this._waitForLMStudioUnload(baseUrl);

        if (freed) {
          logger.info(`[UNLOAD] LMStudio: GPU memory freed`);
        } else {
          logger.warn(`[UNLOAD] LMStudio: timeout waiting for GPU release, forcing continue`);
        }
      }
    } catch {
      logger.debug('[UNLOAD] LMStudio: server not reachable');
    }

    return count;
  }

  private async _waitForLMStudioUnload(
    baseUrl: string,
    keepModel?: string,
    timeoutMs: number = 15000,
  ): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`${baseUrl}/api/v1/models`, { signal: AbortSignal.timeout(3000) });
        const data = (await resp.json()) as { models: LMStudioModelInfo[] };
        const stillLoaded = (data.models || []).filter(
          (m) => m.type === 'llm' && m.loaded_instances?.length && m.key !== keepModel,
        );

        if (stillLoaded.length === 0) {
          return true;
        }

        logger.debug(
          `[WAIT] LMStudio: ${stillLoaded.length} model(s) still in VRAM (${((Date.now() - start) / 1000).toFixed(1)}s)`,
        );
      } catch (err) {
        logger.debug(
          '[WAIT] LMStudio unreachable during poll, assuming unloaded:',
          err instanceof Error ? err.message : String(err),
        );
        return true;
      }

      await sleep(500);
    }

    return false;
  }

  private async _waitForLMStudioModel(baseUrl: string, modelKey: string, timeoutMs: number = 30000): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`${baseUrl}/api/v1/models`, { signal: AbortSignal.timeout(3000) });
        const data = (await resp.json()) as { models: LMStudioModelInfo[] };
        const model = data.models.find((m) => m.key === modelKey);

        if (model?.loaded_instances?.length) {
          const ctx = model.loaded_instances[0].config.context_length;
          logger.info(`[READY] LMStudio: ${modelKey} loaded (ctx=${ctx})`);

          return true;
        }
      } catch (err) {
        logger.debug(`[WAIT] LMStudio model poll retry: ${err instanceof Error ? err.message : String(err)}`);
      }

      await sleep(1000);
    }

    logger.warn(`[TIMEOUT] LMStudio: ${modelKey} did not load within ${timeoutMs}ms`);

    return false;
  }

  async prepareOllama(baseUrl: string, keepModel: string): Promise<void> {
    return this._gpuMutex.acquire(async () => {
      if (this._activeProvider === 'Ollama' && this._activeModel === keepModel) {
        logger.debug(`[SKIP] Ollama/${keepModel} already active`);

        return;
      }

      if (this._gpuMutex.waiting > 0) {
        logger.info(`[QUEUE] ${this._gpuMutex.waiting} request(s) waiting for GPU`);
      }

      const reachable = await this.isOllamaReachable(baseUrl);

      if (!reachable) {
        this._activeProvider = null;
        this._activeModel = null;
        throw new Error(
          `Ollama server is not running at ${baseUrl}. Please start Ollama first (run "ollama serve" in terminal).`,
        );
      }

      logger.info(`========== RESOURCE SWITCH ==========`);
      logger.info(`[TARGET] Ollama / ${keepModel}`);
      logger.info(`[PREV]   ${this._activeProvider || 'none'} / ${this._activeModel || 'none'}`);

      await this._unloadAllLMStudio(this._getLMStudioUrl());

      let alreadyLoaded = false;

      try {
        const psResp = await fetch(`${baseUrl}/api/ps`);
        const psData = (await psResp.json()) as { models: OllamaPsModel[] };

        let unloaded = 0;

        for (const loaded of psData.models || []) {
          if (loaded.name === keepModel) {
            alreadyLoaded = true;
            logger.info(`[KEEP] Ollama: ${loaded.name} already loaded`);
            continue;
          }

          logger.info(`[UNLOAD] Ollama: ${loaded.name}`);

          await fetch(`${baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: loaded.name, keep_alive: 0 }),
          });
          unloaded++;
        }

        if (unloaded > 0) {
          logger.info(`[SWAP] Ollama: waiting for ${unloaded} model(s) to release VRAM...`);

          const freed = await this._waitForOllamaUnload(baseUrl, keepModel);

          if (freed) {
            logger.info(`[SWAP] Ollama: VRAM freed, ready to load ${keepModel}`);
          } else {
            logger.warn(`[SWAP] Ollama: timeout waiting for VRAM release, proceeding anyway`);
          }
        }
      } catch (err) {
        logger.warn(`[ERROR] Ollama cleanup: ${String(err)}`);
      }

      if (!alreadyLoaded) {
        try {
          logger.info(`[PRELOAD] Ollama: warming up ${keepModel}...`);

          const warmup = await fetch(`${baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: keepModel, prompt: 'Hi', options: { num_predict: 1 }, keep_alive: '30m' }),
            signal: AbortSignal.timeout(90_000),
          });

          if (warmup.ok) {
            logger.info(`[PRELOAD] Ollama: ${keepModel} loaded into memory`);
          }
        } catch (err) {
          logger.warn(`[PRELOAD] Ollama: warmup failed (${String(err)}), will load on first request`);
        }
      }

      this._activeProvider = 'Ollama';
      this._activeModel = keepModel;
      logger.info(`[DONE] Ollama/${keepModel} ready`);
      logger.info(`=====================================`);
    });
  }

  async prepareLMStudio(baseUrl: string, keepModel: string, desiredCtx: number = 32768): Promise<void> {
    return this._gpuMutex.acquire(async () => {
      if (this._activeProvider === 'LMStudio' && this._activeModel === keepModel) {
        try {
          const resp = await fetch(`${baseUrl}/api/v1/models`, { signal: AbortSignal.timeout(3000) });
          const data = (await resp.json()) as { models: LMStudioModelInfo[] };
          const model = data.models?.find((m) => m.key === keepModel);

          if (model?.loaded_instances?.length) {
            logger.debug(`[SKIP] LMStudio/${keepModel} already active and verified`);

            return;
          }

          logger.warn(
            `[SKIP-INVALID] LMStudio/${keepModel} was cached as active but is not actually loaded. Re-preparing.`,
          );
          this._activeProvider = null;
          this._activeModel = null;
        } catch {
          logger.debug(`[SKIP] LMStudio/${keepModel} already active (could not verify, trusting cache)`);

          return;
        }
      }

      if (this._gpuMutex.waiting > 0) {
        logger.info(`[QUEUE] ${this._gpuMutex.waiting} request(s) waiting for GPU`);
      }

      const reachable = await this.isLMStudioReachable(baseUrl);

      if (!reachable) {
        this._activeProvider = null;
        this._activeModel = null;
        throw new Error(
          `LM Studio server is not running at ${baseUrl}. Please start LM Studio and enable the local server.`,
        );
      }

      logger.info(`========== RESOURCE SWITCH ==========`);
      logger.info(`[TARGET] LMStudio / ${keepModel}`);
      logger.info(`[PREV]   ${this._activeProvider || 'none'} / ${this._activeModel || 'none'}`);

      await this._unloadAllOllama(this._getOllamaUrl());

      let keepModelLoaded = false;
      let needsWait = false;

      try {
        const resp = await fetch(`${baseUrl}/api/v1/models`);
        const data = (await resp.json()) as { models: LMStudioModelInfo[] };

        for (const m of data.models || []) {
          if (m.type !== 'llm' || !m.loaded_instances?.length) {
            continue;
          }

          for (const inst of m.loaded_instances) {
            if (m.key === keepModel) {
              keepModelLoaded = true;
              logger.info(`[KEEP] LMStudio: ${m.key} already loaded (ctx=${inst.config.context_length})`);
              continue;
            }

            logger.info(`[UNLOAD] LMStudio: ${m.key} (ctx=${inst.config.context_length})`);

            await fetch(`${baseUrl}/api/v1/models/unload`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ instance_id: inst.id }),
            });
            needsWait = true;
          }
        }

        if (needsWait) {
          logger.info(`[SWAP] LMStudio: waiting for unloaded models to release VRAM...`);

          const freed = await this._waitForLMStudioUnload(baseUrl, keepModel);

          if (freed) {
            logger.info(`[SWAP] LMStudio: VRAM freed, ready to load ${keepModel}`);
          } else {
            logger.warn(`[SWAP] LMStudio: timeout waiting for VRAM release, proceeding anyway`);
          }
        }

        if (!keepModelLoaded) {
          const targetModel = data.models.find((m) => m.key === keepModel);

          if (targetModel) {
            const maxCtx = targetModel.max_context_length || 131072;
            const ctx = Math.min(desiredCtx, maxCtx);

            logger.info(`[LOAD] LMStudio: ${keepModel} (ctx=${ctx}, max=${maxCtx})`);

            const loadResp = await fetch(`${baseUrl}/api/v1/models/load`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: keepModel,
                context_length: ctx,
                flash_attention: true,
              }),
            });

            const loadResult = (await loadResp.json()) as any;
            logger.info(`[LOAD] LMStudio result: ${JSON.stringify(loadResult)}`);

            if (loadResult?.error) {
              const errMsg = loadResult.error?.message || JSON.stringify(loadResult.error);
              throw new Error(`LM Studio failed to load model "${keepModel}": ${errMsg}`);
            }

            const modelLoaded = await this._waitForLMStudioModel(baseUrl, keepModel);

            if (!modelLoaded) {
              throw new Error(
                `LM Studio model "${keepModel}" did not load within timeout. ` +
                  `Possible causes: insufficient VRAM, corrupted model file, or guardrails blocking load.`,
              );
            }
          } else {
            throw new Error(
              `Model "${keepModel}" not found in LM Studio. Available models: ${data.models.map((m) => m.key).join(', ')}`,
            );
          }
        }
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes('not running') ||
            err.message.includes('not found') ||
            err.message.includes('failed to load') ||
            err.message.includes('did not load'))
        ) {
          throw err;
        }

        logger.error(`[ERROR] LMStudio resource management: ${String(err)}`);
        throw new Error(`Failed to prepare LM Studio model "${keepModel}": ${String(err)}`);
      }

      this._activeProvider = 'LMStudio';
      this._activeModel = keepModel;
      logger.info(`[DONE] LMStudio/${keepModel} ready`);
      logger.info(`=====================================`);
    });
  }

  async unloadAll(): Promise<void> {
    return this._gpuMutex.acquire(async () => {
      if (!this._activeProvider) {
        return;
      }

      logger.info(`========== RESOURCE CLEANUP ==========`);
      logger.info(`[CLEANUP] Switching to cloud provider, freeing local resources`);
      logger.info(`[PREV] ${this._activeProvider} / ${this._activeModel}`);

      const ollamaFreed = await this._unloadAllOllama(this._getOllamaUrl());
      const lmsFreed = await this._unloadAllLMStudio(this._getLMStudioUrl());

      logger.info(`[DONE] Freed ${ollamaFreed + lmsFreed} model(s) total`);
      logger.info(`======================================`);

      this._activeProvider = null;
      this._activeModel = null;
    });
  }

  async forceUnloadAll(): Promise<{ ollama: number; lmstudio: number }> {
    return this._gpuMutex.acquire(async () => {
      logger.info(`========== FORCE UNLOAD ALL ==========`);
      logger.info(`[FORCE] Unloading all models from Ollama and LM Studio`);

      const ollamaFreed = await this._unloadAllOllama(this._getOllamaUrl());
      const lmsFreed = await this._unloadAllLMStudio(this._getLMStudioUrl());

      logger.info(`[DONE] Force-freed ${ollamaFreed + lmsFreed} model(s) total`);
      logger.info(`======================================`);

      this._activeProvider = null;
      this._activeModel = null;

      return { ollama: ollamaFreed, lmstudio: lmsFreed };
    });
  }

  resetTracking(): void {
    this._activeProvider = null;
    this._activeModel = null;
  }
}

export const resourceManager = ResourceManager.getInstance();
