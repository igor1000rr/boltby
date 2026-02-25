import { convertToCoreMessages, streamText as _streamText, type Message } from 'ai';
import { MAX_TOKENS, type FileMap } from './constants';
import { getSystemPrompt } from '~/lib/common/prompts/prompts';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, MODIFICATIONS_TAG_NAME, PROVIDER_LIST, WORK_DIR } from '~/utils/constants';
import type { IProviderSetting } from '~/types/model';
import { PromptLibrary } from '~/lib/common/prompt-library';
import { allowedHTMLElements } from '~/utils/markdown';
import { LLMManager } from '~/lib/modules/llm/manager';
import { createScopedLogger } from '~/utils/logger';
import { createFilesContext, extractPropertiesFromMessage } from './utils';

export type Messages = Message[];

export interface StreamingOptions extends Omit<Parameters<typeof _streamText>[0], 'model'> {}

const logger = createScopedLogger('stream-text');

export async function streamText(props: {
  messages: Omit<Message, 'id'>[];
  env?: Env;
  options?: StreamingOptions;
  apiKeys?: Record<string, string>;
  files?: FileMap;
  providerSettings?: Record<string, IProviderSetting>;
  promptId?: string;
  contextOptimization?: boolean;
  contextFiles?: FileMap;
  summary?: string;
  messageSliceId?: number;
}) {
  const {
    messages,
    env: serverEnv,
    options,
    apiKeys,
    files,
    providerSettings,
    promptId,
    contextOptimization,
    contextFiles,
    summary,
  } = props;
  let currentModel = DEFAULT_MODEL;
  let currentProvider = DEFAULT_PROVIDER.name;
  let processedMessages = messages.map((message) => {
    if (message.role === 'user') {
      const { model, provider, content } = extractPropertiesFromMessage(message);
      currentModel = model;
      currentProvider = provider;

      return { ...message, content };
    } else if (message.role == 'assistant') {
      let content = message.content;
      content = content.replace(/<div class=\\"__boltThought__\\">.*?<\/div>/s, '');
      content = content.replace(/<think>.*?<\/think>/s, '');

      // Remove package-lock.json content specifically keeping token usage MUCH lower
      content = content.replace(
        /<boltAction type="file" filePath="package-lock\.json">[\s\S]*?<\/boltAction>/g,
        '[package-lock.json content removed]',
      );

      // Trim whitespace potentially left after removals
      content = content.trim();

      return { ...message, content };
    }

    return message;
  });

  const provider = PROVIDER_LIST.find((p) => p.name === currentProvider) || DEFAULT_PROVIDER;
  const staticModels = LLMManager.getInstance().getStaticModelListFromProvider(provider);
  let modelDetails = staticModels.find((m) => m.name === currentModel);

  if (!modelDetails) {
    const modelsList = [
      ...(provider.staticModels || []),
      ...(await LLMManager.getInstance().getModelListFromProvider(provider, {
        apiKeys,
        providerSettings,
        serverEnv: serverEnv as any,
      })),
    ];

    if (!modelsList.length) {
      throw new Error(`No models found for provider ${provider.name}`);
    }

    modelDetails = modelsList.find((m) => m.name === currentModel);

    if (!modelDetails) {
      // Smart fallback: prefer code-capable models, then any available model
      const codeFallback = modelsList.find((m) => {
        const id = m.name.toLowerCase();
        return id.includes('coder') || id.includes('code') || id.includes('qwen') || id.includes('deepseek');
      });
      const fallback = codeFallback || modelsList[0];

      if (fallback) {
        logger.warn(
          `MODEL [${currentModel}] not found in provider [${provider.name}]. Falling back to [${fallback.name}].`,
        );
        modelDetails = fallback;
        currentModel = fallback.name;
      } else {
        logger.warn(
          `MODEL [${currentModel}] not found in provider [${provider.name}] cache. Using requested model directly.`,
        );
        modelDetails = {
          name: currentModel,
          label: currentModel,
          provider: provider.name,
          maxTokenAllowed: 8192,
        };
      }
    }
  }

  const dynamicMaxTokens = modelDetails && modelDetails.maxTokenAllowed ? modelDetails.maxTokenAllowed : MAX_TOKENS;

  let effectivePromptId = promptId || 'default';

  if (!promptId) {
    if (dynamicMaxTokens >= 32768) {
      effectivePromptId = 'default';
    } else if (dynamicMaxTokens >= 12288) {
      effectivePromptId = 'optimized';
    } else {
      effectivePromptId = 'compact';
    }

    logger.info(`Prompt selection: ${effectivePromptId} for ${currentModel} (ctx=${dynamicMaxTokens})`);
  }

  let systemPrompt =
    PromptLibrary.getPropmtFromLibrary(effectivePromptId, {
      cwd: WORK_DIR,
      allowedHtmlElements: allowedHTMLElements,
      modificationTagName: MODIFICATIONS_TAG_NAME,
    }) ?? getSystemPrompt();

  if (contextFiles && contextOptimization) {
    const codeContext = createFilesContext(contextFiles, true);

    systemPrompt = `${systemPrompt}

Below is the artifact containing the context loaded into context buffer for you to have knowledge of and might need changes to fullfill current user request.
CONTEXT BUFFER:
---
${codeContext}
---
`;

    if (summary) {
      systemPrompt = `${systemPrompt}

CHAT CONTEXT (session history and current task):
---
${props.summary}
---
`;

      if (props.messageSliceId) {
        // Keep sliced messages but ensure we always have at least last 5 for continuity
        const sliced = processedMessages.slice(props.messageSliceId);
        processedMessages = sliced.length >= 2 ? sliced : processedMessages.slice(-5);
      } else {
        // Keep last 5 messages so model remembers recent conversation turns
        processedMessages = processedMessages.slice(-5);
      }
    }
  }

  const effectiveLockedFilePaths = new Set<string>();

  if (files) {
    for (const [filePath, fileDetails] of Object.entries(files)) {
      if (fileDetails?.isLocked) {
        effectiveLockedFilePaths.add(filePath);
      }
    }
  }

  if (effectiveLockedFilePaths.size > 0) {
    const lockedFilesListString = Array.from(effectiveLockedFilePaths)
      .map((filePath) => `- ${filePath}`)
      .join('\n');
    systemPrompt = `${systemPrompt}

IMPORTANT: The following files are locked and MUST NOT be modified in any way. Do not suggest or make any changes to these files. You can proceed with the request but DO NOT make any changes to these files specifically:
${lockedFilesListString}
---
`;
  } else {
    logger.debug('No locked files found from any source for prompt.');
  }

  const estimateTokens = (text: string) => Math.ceil(text.split(/\s+/).length * 2.5);

  let systemPromptTokens = estimateTokens(systemPrompt);
  const messageTokens = processedMessages.reduce(
    (sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
    0,
  );
  const SAFETY_MARGIN = 500;
  let usedTokens = systemPromptTokens + messageTokens + SAFETY_MARGIN;
  const isOverflow = usedTokens > dynamicMaxTokens;

  if (isOverflow && effectivePromptId !== 'compact') {
    logger.warn(
      `Context OVERFLOW: used=${usedTokens} > ctx=${dynamicMaxTokens}. Switching to compact prompt to save artifact instructions.`,
    );

    const compactPrompt = PromptLibrary.getPropmtFromLibrary('compact', {
      cwd: WORK_DIR,
      allowedHtmlElements: allowedHTMLElements,
      modificationTagName: MODIFICATIONS_TAG_NAME,
    });

    if (compactPrompt) {
      systemPrompt = compactPrompt;
      effectivePromptId = 'compact';
      systemPromptTokens = estimateTokens(systemPrompt);
      usedTokens = systemPromptTokens + messageTokens + SAFETY_MARGIN;
    }
  }

  if (isOverflow && usedTokens > dynamicMaxTokens) {
    const keepCount = Math.max(2, Math.floor((dynamicMaxTokens - systemPromptTokens - SAFETY_MARGIN) / 300));
    processedMessages = processedMessages.slice(-keepCount);

    const trimmedMsgTokens = processedMessages.reduce(
      (sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
      0,
    );
    usedTokens = systemPromptTokens + trimmedMsgTokens + SAFETY_MARGIN;

    logger.warn(`Still overflowing after compact prompt. Trimmed messages to last ${keepCount} (used=${usedTokens}).`);
  }

  const availableForOutput = Math.max(4096, dynamicMaxTokens - usedTokens);

  logger.info(
    `Token budget: ctx=${dynamicMaxTokens}, prompt=${systemPromptTokens}, msgs=${messageTokens}, output=${availableForOutput}, promptId=${effectivePromptId}`,
  );

  const isLocalProvider = currentProvider === 'Ollama' || currentProvider === 'LMStudio';
  const isQwen3 = currentModel.toLowerCase().includes('qwen3');

  if (isQwen3) {
    systemPrompt = `/no_think\n${systemPrompt}`;
    logger.info('Qwen3 detected: prepended /no_think to disable thinking mode');
  }

  if (isLocalProvider) {
    systemPrompt += `\n\nREMINDER: You MUST wrap ALL code in <boltArtifact> and <boltAction> tags. NEVER write raw code or HTML in chat text. Start your response with <boltArtifact id="..." title="...">.`;
  }

  logger.info(`Sending llm call to ${provider.name} with model ${modelDetails.name}`);

  return await _streamText({
    model: provider.getModelInstance({
      model: modelDetails.name,
      serverEnv,
      apiKeys,
      providerSettings,
    }),
    system: systemPrompt,
    maxTokens: availableForOutput,
    messages: convertToCoreMessages(processedMessages as any),
    ...options,
  });
}
