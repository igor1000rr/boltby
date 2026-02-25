import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV1 } from 'ai';
import { logger } from '~/utils/logger';

const DESIRED_CTX = 32768;

interface LMStudioModelInfo {
  key: string;
  display_name: string;
  type: string;
  params_string: string | null;
  max_context_length: number;
  loaded_instances: Array<{
    id: string;
    config: { context_length: number };
  }>;
}

export default class LMStudioProvider extends BaseProvider {
  name = 'LMStudio';
  getApiKeyLink = 'https://lmstudio.ai/';
  labelForGetApiKey = 'Get LMStudio';
  icon = 'i-ph:cloud-arrow-down';

  config = {
    baseUrlKey: 'LMSTUDIO_API_BASE_URL',
    baseUrl: 'http://localhost:1234/',
  };

  staticModels: ModelInfo[] = [
    { name: 'qwen2.5-coder-7b-instruct', label: 'Qwen2.5 Coder 7B', provider: 'LMStudio', maxTokenAllowed: 32768 },
    { name: 'qwen/qwen3-8b', label: 'Qwen3 8B', provider: 'LMStudio', maxTokenAllowed: 32768 },
    { name: 'codegemma-1.1-7b-it', label: 'CodeGemma 1.1 7B', provider: 'LMStudio', maxTokenAllowed: 8192 },
    {
      name: 'deepseek/deepseek-r1-0528-qwen3-8b',
      label: 'DeepSeek R1 Qwen3 8B',
      provider: 'LMStudio',
      maxTokenAllowed: 32768,
    },
    { name: 'exaone-3.5-7.8b-instruct', label: 'EXAONE 3.5 7.8B', provider: 'LMStudio', maxTokenAllowed: 32768 },
    { name: 'google/gemma-3-4b', label: 'Gemma 3 4B', provider: 'LMStudio', maxTokenAllowed: 32768 },
    { name: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', provider: 'LMStudio', maxTokenAllowed: 32768 },
    { name: 'qwen/qwen3-vl-8b', label: 'Qwen3 VL 8B (Vision)', provider: 'LMStudio', maxTokenAllowed: 32768 },
    {
      name: 'nvidia-nemotron-nano-9b-v2-base',
      label: 'Nemotron Nano 9B',
      provider: 'LMStudio',
      maxTokenAllowed: 32768,
    },
    { name: 'phi-3.5-mini-instruct', label: 'Phi 3.5 Mini', provider: 'LMStudio', maxTokenAllowed: 16384 },
  ];

  private _resolveBaseUrl(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv?: Record<string, string>,
  ): string {
    let { baseUrl } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv: serverEnv || {},
      defaultBaseUrlKey: 'LMSTUDIO_API_BASE_URL',
      defaultApiTokenKey: '',
    });

    if (!baseUrl) {
      throw new Error('No baseUrl found for LMStudio provider');
    }

    if (typeof window === 'undefined') {
      const isDocker = process?.env?.RUNNING_IN_DOCKER === 'true' || serverEnv?.RUNNING_IN_DOCKER === 'true';

      if (isDocker) {
        baseUrl = baseUrl.replace('localhost', 'host.docker.internal');
        baseUrl = baseUrl.replace('127.0.0.1', 'host.docker.internal');
      }
    }

    return baseUrl;
  }

  /**
   * If a loaded model has context_length < DESIRED_CTX, unload and reload it
   * with the larger context (capped at the model's max_context_length).
   */
  private async _ensureContext(baseUrl: string, model: LMStudioModelInfo): Promise<void> {
    if (typeof window !== 'undefined' || model.type !== 'llm') {
      return;
    }

    for (const inst of model.loaded_instances) {
      if (inst.config.context_length >= DESIRED_CTX) {
        continue;
      }

      const targetCtx = Math.min(DESIRED_CTX, model.max_context_length);

      logger.info(`LMStudio: reloading ${model.key} with context ${inst.config.context_length} → ${targetCtx}`);

      try {
        await fetch(`${baseUrl}/api/v1/models/unload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instance_id: inst.id }),
        });

        await fetch(`${baseUrl}/api/v1/models/load`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model.key,
            context_length: targetCtx,
            flash_attention: true,
          }),
        });
      } catch (err) {
        logger.warn(`LMStudio: failed to reload ${model.key}`, err);
      }
    }
  }

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    const baseUrl = this._resolveBaseUrl(apiKeys, settings, serverEnv);

    let models: LMStudioModelInfo[] = [];

    try {
      const extResp = await fetch(`${baseUrl}/api/v1/models`);
      const extData = (await extResp.json()) as { models: LMStudioModelInfo[] };
      models = extData.models.filter((m) => m.type === 'llm');

      for (const m of models) {
        await this._ensureContext(baseUrl, m);
      }
    } catch (err) {
      logger.debug(
        'LMStudio extended API unavailable, falling back to OpenAI endpoint:',
        err instanceof Error ? err.message : String(err),
      );
    }

    if (models.length > 0) {
      return models.map((m) => ({
        name: m.key,
        label: `${m.display_name}${m.params_string ? ` (${m.params_string})` : ''}`,
        provider: this.name,
        maxTokenAllowed: Math.min(DESIRED_CTX, m.max_context_length),
      }));
    }

    const response = await fetch(`${baseUrl}/v1/models`);
    const data = (await response.json()) as { data: Array<{ id: string }> };

    return data.data
      .filter((model) => !model.id.includes('embed'))
      .map((model) => ({
        name: model.id,
        label: model.id,
        provider: this.name,
        maxTokenAllowed: DESIRED_CTX,
      }));
  }

  getModelInstance: (options: {
    model: string;
    serverEnv?: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }) => LanguageModelV1 = (options) => {
    const { apiKeys, providerSettings, serverEnv, model } = options;
    const baseUrl = this._resolveBaseUrl(apiKeys, providerSettings?.[this.name], serverEnv as any);

    logger.debug('LMStudio Base Url used: ', baseUrl);

    const lmstudio = createOpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: '',
    });

    return lmstudio(model);
  };
}
