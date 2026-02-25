import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { ollama } from 'ollama-ai-provider';
import { logger } from '~/utils/logger';

interface OllamaModelDetails {
  parent_model: string;
  format: string;
  family: string;
  families: string[];
  parameter_size: string;
  quantization_level: string;
}

export interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: OllamaModelDetails;
}

export interface OllamaApiResponse {
  models: OllamaModel[];
}

let _gpuVramMB: number | null = null;

async function initGpuVram(): Promise<void> {
  if (_gpuVramMB !== null || typeof window !== 'undefined') {
    return;
  }

  try {
    const cp = await import('node:child_process');
    const out = cp
      .execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', {
        encoding: 'utf-8',
        timeout: 5000,
      })
      .trim();
    _gpuVramMB = parseInt(out.split('\n')[0], 10) || 0;
    logger.info(`GPU VRAM detected: ${_gpuVramMB} MB`);
  } catch {
    _gpuVramMB = 0;
    logger.debug('GPU VRAM detection unavailable (no nvidia-smi)');
  }
}

function getGpuVramMB(): number {
  return _gpuVramMB ?? 0;
}

/**
 * Pick a safe num_ctx based on model weight file size.
 * KV cache grows proportionally to num_ctx × model_dim, so larger models
 * with big context windows explode GPU memory (e.g. 14B Q5 = 8.4GB file,
 * but 32K ctx adds ~7GB KV cache → 15GB total, forcing CPU/GPU split).
 *
 * Minimum is 12288 because bolt.diy system prompt + conversation needs ~10K tokens.
 */
function pickNumCtx(modelSizeBytes: number, desiredCtx: number): number {
  const MIN_CTX = 12288;
  const sizeGB = modelSizeBytes / (1024 * 1024 * 1024);

  let cap = desiredCtx;

  if (sizeGB > 25) {
    cap = 12288;
  } else if (sizeGB > 14) {
    cap = 16384;
  } else if (sizeGB > 10) {
    cap = 16384;
  } else if (sizeGB > 5) {
    cap = 24576;
  } else if (sizeGB > 3) {
    cap = 32768;
  }

  return Math.max(MIN_CTX, Math.min(desiredCtx, cap));
}

/**
 * Calculate safe GPU layer count to prevent VRAM OOM.
 * If the model is larger than available GPU VRAM (minus KV cache overhead),
 * we limit how many transformer blocks are offloaded to the GPU.
 * This overrides any num_gpu set in the Modelfile.
 *
 * KV cache sizing:
 *   Dense models  — ~1 GB per 8K tokens of context
 *   MoE models    — ~0.4 GB per 8K (only active experts maintain KV)
 *   Small models (<5 GB) — ~0.3 GB per 8K
 */
function pickNumGpu(modelSizeBytes: number, numCtx: number): number | undefined {
  if (modelSizeBytes === 0) {
    return undefined;
  }

  const vramMB = getGpuVramMB();

  if (vramMB === 0) {
    return undefined;
  }

  const modelMB = modelSizeBytes / (1024 * 1024);
  const sizeGB = modelSizeBytes / (1024 * 1024 * 1024);

  const isMoE = sizeGB > 15 && modelMB / sizeGB > 1000;
  const kvPerCtxChunk = isMoE ? 400 : sizeGB < 5 ? 300 : 700;
  const kvCacheMB = (numCtx / 8192) * kvPerCtxChunk;

  const availableForWeightsMB = vramMB * 0.9 - kvCacheMB;

  if (availableForWeightsMB >= modelMB) {
    return undefined;
  }

  if (availableForWeightsMB <= 256) {
    return 1;
  }

  const estimatedBlocks = Math.max(24, Math.round(sizeGB * 2.8));
  const ratio = availableForWeightsMB / modelMB;

  return Math.max(1, Math.floor(estimatedBlocks * ratio));
}

export default class OllamaProvider extends BaseProvider {
  name = 'Ollama';
  getApiKeyLink = 'https://ollama.com/download';
  labelForGetApiKey = 'Download Ollama';
  icon = 'i-ph:cloud-arrow-down';

  config = {
    baseUrlKey: 'OLLAMA_API_BASE_URL',
  };

  staticModels: ModelInfo[] = [
    {
      name: 'qwen2.5-coder:14b-instruct',
      label: 'Qwen 2.5 Coder 14B Instruct',
      provider: 'Ollama',
      maxTokenAllowed: 16384,
    },
    {
      name: 'qwen2.5-coder:7b-instruct',
      label: 'Qwen 2.5 Coder 7B Instruct',
      provider: 'Ollama',
      maxTokenAllowed: 24576,
    },
    {
      name: 'qwen3-coder:30b-a3b-q4_K_M',
      label: 'Qwen3 Coder 30B MoE (3B active)',
      provider: 'Ollama',
      maxTokenAllowed: 32768,
    },
    { name: 'devstral:24b', label: 'Devstral 24B (Mistral Code)', provider: 'Ollama', maxTokenAllowed: 12288 },
    { name: 'deepseek-coder-v2:16b', label: 'DeepSeek Coder V2 16B', provider: 'Ollama', maxTokenAllowed: 16384 },
    { name: 'deepseek-r1:14b', label: 'DeepSeek R1 14B (Reasoning)', provider: 'Ollama', maxTokenAllowed: 16384 },
    { name: 'deepseek-r1:8b', label: 'DeepSeek R1 8B (Reasoning)', provider: 'Ollama', maxTokenAllowed: 24576 },
    { name: 'qwen3:8b-q4_K_M', label: 'Qwen3 8B', provider: 'Ollama', maxTokenAllowed: 32768 },
  ];

  private _modelSizeMap = new Map<string, number>();

  private _lookupModelSize(model: string): number {
    return (
      this._modelSizeMap.get(model) ||
      this._modelSizeMap.get(model + ':latest') ||
      this._modelSizeMap.get(model.replace(/:latest$/, '')) ||
      0
    );
  }

  private _convertEnvToRecord(env?: Env): Record<string, string> {
    if (!env) {
      return {};
    }

    return Object.entries(env).reduce(
      (acc, [key, value]) => {
        acc[key] = String(value);
        return acc;
      },
      {} as Record<string, string>,
    );
  }

  getDefaultNumCtx(serverEnv?: Env): number {
    const envRecord = this._convertEnvToRecord(serverEnv);
    return envRecord.DEFAULT_NUM_CTX ? parseInt(envRecord.DEFAULT_NUM_CTX, 10) : 32768;
  }

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    await initGpuVram();

    let { baseUrl } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: 'OLLAMA_API_BASE_URL',
      defaultApiTokenKey: '',
    });

    if (!baseUrl) {
      throw new Error('No baseUrl found for OLLAMA provider');
    }

    if (typeof window === 'undefined') {
      const isDocker = process?.env?.RUNNING_IN_DOCKER === 'true' || serverEnv?.RUNNING_IN_DOCKER === 'true';

      baseUrl = isDocker ? baseUrl.replace('localhost', 'host.docker.internal') : baseUrl;
      baseUrl = isDocker ? baseUrl.replace('127.0.0.1', 'host.docker.internal') : baseUrl;
    }

    const response = await fetch(`${baseUrl}/api/tags`);
    const data = (await response.json()) as OllamaApiResponse;

    const desiredCtx = this.getDefaultNumCtx(serverEnv as unknown as Env);

    return data.models.map((model: OllamaModel) => {
      this._modelSizeMap.set(model.name, model.size);

      const numCtx = pickNumCtx(model.size, desiredCtx);

      return {
        name: model.name,
        label: `${model.name} (${model.details.parameter_size})`,
        provider: this.name,
        maxTokenAllowed: numCtx,
      };
    });
  }

  getModelInstance: (options: {
    model: string;
    serverEnv?: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }) => LanguageModelV1 = (options) => {
    const { apiKeys, providerSettings, serverEnv, model } = options;
    const envRecord = this._convertEnvToRecord(serverEnv);

    let { baseUrl } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv: envRecord,
      defaultBaseUrlKey: 'OLLAMA_API_BASE_URL',
      defaultApiTokenKey: '',
    });

    if (!baseUrl) {
      throw new Error('No baseUrl found for OLLAMA provider');
    }

    const isDocker = process?.env?.RUNNING_IN_DOCKER === 'true' || envRecord.RUNNING_IN_DOCKER === 'true';
    baseUrl = isDocker ? baseUrl.replace('localhost', 'host.docker.internal') : baseUrl;
    baseUrl = isDocker ? baseUrl.replace('127.0.0.1', 'host.docker.internal') : baseUrl;

    const desiredCtx = this.getDefaultNumCtx(serverEnv);
    const modelSize = this._lookupModelSize(model);
    const sizeGB = modelSize / (1024 * 1024 * 1024);
    const isUnknownModel = modelSize === 0;
    const numCtx = isUnknownModel ? desiredCtx : pickNumCtx(modelSize, desiredCtx);
    const numGpu = isUnknownModel ? undefined : pickNumGpu(modelSize, numCtx);

    logger.info(
      `Ollama: ${model} (${sizeGB.toFixed(1)}GB) → num_ctx=${numCtx}${numGpu !== undefined ? `, num_gpu=${numGpu}` : ''}`,
    );

    const ollamaInstance = ollama(model, {
      numCtx,
      ...(numGpu !== undefined && { numGpu }),
    }) as LanguageModelV1 & { config: any };

    ollamaInstance.config.baseURL = `${baseUrl}/api`;

    return ollamaInstance;
  };
}
