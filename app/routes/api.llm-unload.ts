import { json } from '@remix-run/cloudflare';
import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { resourceManager } from '~/lib/modules/llm/resource-manager';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.llm-unload');

export async function action(_args: ActionFunctionArgs) {
  try {
    logger.info('[REQUEST] Force unload all LLMs from memory');

    const result = await resourceManager.forceUnloadAll();
    const total = result.ollama + result.lmstudio;

    logger.info(`[DONE] Unloaded: Ollama=${result.ollama}, LMStudio=${result.lmstudio}`);

    return json({
      success: true,
      unloaded: {
        ollama: result.ollama,
        lmstudio: result.lmstudio,
        total,
      },
      message:
        total > 0
          ? `Выгружено ${total} модел${total === 1 ? 'ь' : total < 5 ? 'и' : 'ей'} из памяти (Ollama: ${result.ollama}, LM Studio: ${result.lmstudio})`
          : 'Нет загруженных моделей для выгрузки',
    });
  } catch (error) {
    logger.error(`[ERROR] Force unload failed: ${String(error)}`);

    return json(
      {
        success: false,
        error: String(error),
        message: 'Ошибка при выгрузке моделей из памяти',
      },
      { status: 500 },
    );
  }
}
