import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createDataStream, generateId } from 'ai';
import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from '~/lib/.server/llm/constants';
import { CONTINUE_PROMPT } from '~/lib/common/prompts/prompts';
import { streamText, type Messages, type StreamingOptions } from '~/lib/.server/llm/stream-text';
import SwitchableStream from '~/lib/.server/llm/switchable-stream';
import type { IProviderSetting } from '~/types/model';
import { createScopedLogger } from '~/utils/logger';
import { getFilePaths, selectContext } from '~/lib/.server/llm/select-context';
import type { ContextAnnotation, ProgressAnnotation } from '~/types/context';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, WORK_DIR } from '~/utils/constants';
import { createSummary } from '~/lib/.server/llm/create-summary';
import { buildLocalContext, extractPropertiesFromMessage } from '~/lib/.server/llm/utils';
import { resourceManager } from '~/lib/modules/llm/resource-manager';

export async function action(args: ActionFunctionArgs) {
  return chatAction(args);
}

const logger = createScopedLogger('api.chat');

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  const items = cookieHeader.split(';').map((cookie) => cookie.trim());

  items.forEach((item) => {
    const [name, ...rest] = item.split('=');

    if (name && rest) {
      const decodedName = decodeURIComponent(name.trim());
      const decodedValue = decodeURIComponent(rest.join('=').trim());
      cookies[decodedName] = decodedValue;
    }
  });

  return cookies;
}

async function chatAction({ context, request }: ActionFunctionArgs) {
  const { messages, files, promptId, contextOptimization } = await request.json<{
    messages: Messages;
    files: any;
    promptId?: string;
    contextOptimization: boolean;
  }>();

  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = JSON.parse(parseCookies(cookieHeader || '').apiKeys || '{}');
  const providerSettings: Record<string, IProviderSetting> = JSON.parse(
    parseCookies(cookieHeader || '').providers || '{}',
  );

  const stream = new SwitchableStream();

  const cumulativeUsage = {
    completionTokens: 0,
    promptTokens: 0,
    totalTokens: 0,
  };
  const encoder: TextEncoder = new TextEncoder();
  let progressCounter: number = 1;

  try {
    const totalMessageContent = messages.reduce((acc, message) => acc + message.content, '');
    logger.debug(`Total message length: ${totalMessageContent.split(' ').length}, words`);

    let lastChunk: string | undefined = undefined;

    const dataStream = createDataStream({
      async execute(dataStream) {
        const filePaths = getFilePaths(files || {});
        let filteredFiles: FileMap | undefined = undefined;
        let summary: string | undefined = undefined;

        let messageSliceId = 0;

        if (messages.length > 5) {
          messageSliceId = messages.length - 5;
        }

        // Determine provider/model from last user message BEFORE any LLM call
        let targetModel = DEFAULT_MODEL;
        let targetProviderName = DEFAULT_PROVIDER.name;

        for (const msg of messages) {
          if (msg.role === 'user') {
            const extracted = extractPropertiesFromMessage(msg);
            targetModel = extracted.model;
            targetProviderName = extracted.provider;
          }
        }

        const envRecord = (context.cloudflare?.env || {}) as unknown as Record<string, string>;

        // Prepare GPU/RAM resources BEFORE any LLM call
        const ollamaBase =
          providerSettings?.Ollama?.baseUrl ||
          envRecord.OLLAMA_API_BASE_URL ||
          process?.env?.OLLAMA_API_BASE_URL ||
          'http://127.0.0.1:11434';
        const lmsBase =
          providerSettings?.LMStudio?.baseUrl ||
          envRecord.LMSTUDIO_API_BASE_URL ||
          process?.env?.LMSTUDIO_API_BASE_URL ||
          'http://127.0.0.1:1234';

        if (targetProviderName === 'Ollama') {
          dataStream.writeData({
            type: 'progress',
            label: 'resources',
            status: 'in-progress',
            order: progressCounter++,
            message: `Loading Ollama model: ${targetModel}`,
          } satisfies ProgressAnnotation);

          try {
            await resourceManager.prepareOllama(ollamaBase, targetModel);
          } catch (rmErr: any) {
            dataStream.writeData({
              type: 'progress',
              label: 'resources',
              status: 'complete',
              order: progressCounter++,
              message: `Error: ${rmErr?.message || 'Ollama not available'}`,
            } satisfies ProgressAnnotation);
            throw rmErr;
          }

          dataStream.writeData({
            type: 'progress',
            label: 'resources',
            status: 'complete',
            order: progressCounter++,
            message: `Ollama model ready: ${targetModel}`,
          } satisfies ProgressAnnotation);
        } else if (targetProviderName === 'LMStudio') {
          dataStream.writeData({
            type: 'progress',
            label: 'resources',
            status: 'in-progress',
            order: progressCounter++,
            message: `Loading LM Studio model: ${targetModel}`,
          } satisfies ProgressAnnotation);

          try {
            await resourceManager.prepareLMStudio(lmsBase, targetModel);
          } catch (rmErr: any) {
            logger.warn(`LM Studio unavailable, attempting Ollama fallback: ${rmErr?.message}`);

            dataStream.writeData({
              type: 'progress',
              label: 'resources',
              status: 'in-progress',
              order: progressCounter++,
              message: `LM Studio unavailable. Trying Ollama fallback...`,
            } satisfies ProgressAnnotation);

            const ollamaReachable = await resourceManager.isOllamaReachable(ollamaBase);

            if (ollamaReachable) {
              const fallbackModel = 'qwen2.5-coder:7b-instruct';

              await resourceManager.prepareOllama(ollamaBase, fallbackModel);

              const replaceModelTag = (text: string) =>
                text
                  .replace(/\[Model:.*?\]/g, `[Model: ${fallbackModel}]`)
                  .replace(/\[Provider:.*?\]/g, `[Provider: Ollama]`);

              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'user') {
                  const rawContent = messages[i].content;

                  if (typeof rawContent === 'string') {
                    messages[i] = { ...messages[i], content: replaceModelTag(rawContent) };
                  } else if (Array.isArray(rawContent)) {
                    messages[i] = {
                      ...messages[i],
                      content: (rawContent as any[]).map((part: any) =>
                        part?.type === 'text' ? { ...part, text: replaceModelTag(part.text || '') } : part,
                      ),
                    } as any;
                  }

                  break;
                }
              }

              dataStream.writeData({
                type: 'progress',
                label: 'resources',
                status: 'complete',
                order: progressCounter++,
                message: `Fallback: using Ollama/${fallbackModel} (LM Studio is offline)`,
              } satisfies ProgressAnnotation);
            } else {
              dataStream.writeData({
                type: 'progress',
                label: 'resources',
                status: 'complete',
                order: progressCounter++,
                message: `Error: No local LLM servers available. Start LM Studio or Ollama.`,
              } satisfies ProgressAnnotation);
              throw new Error('No local LLM servers available. Please start LM Studio or Ollama.');
            }
          }
        } else {
          await resourceManager.unloadAll();
        }

        const isLocalProvider = targetProviderName === 'Ollama' || targetProviderName === 'LMStudio';

        if (filePaths.length > 0 && contextOptimization && !isLocalProvider) {
          try {
            logger.debug('Generating Chat Summary');
            dataStream.writeData({
              type: 'progress',
              label: 'summary',
              status: 'in-progress',
              order: progressCounter++,
              message: 'Analysing Request',
            } satisfies ProgressAnnotation);

            logger.debug(`Messages count: ${messages.length}`);

            summary = await createSummary({
              messages: [...messages],
              env: context.cloudflare?.env,
              apiKeys,
              providerSettings,
              promptId,
              contextOptimization,
              onFinish(resp) {
                if (resp.usage) {
                  logger.debug('createSummary token usage', JSON.stringify(resp.usage));
                  cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                  cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                  cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
                }
              },
            });
            dataStream.writeData({
              type: 'progress',
              label: 'summary',
              status: 'complete',
              order: progressCounter++,
              message: summary ? 'Analysis Complete' : 'Skipped (timeout or too large)',
            } satisfies ProgressAnnotation);

            if (summary) {
              dataStream.writeMessageAnnotation({
                type: 'chatSummary',
                summary,
                chatId: messages.slice(-1)?.[0]?.id,
              } as ContextAnnotation);
            }
          } catch (summaryErr: any) {
            logger.warn(`Summary failed, continuing without it: ${summaryErr?.message}`);
            dataStream.writeData({
              type: 'progress',
              label: 'summary',
              status: 'complete',
              order: progressCounter++,
              message: 'Skipped (error)',
            } satisfies ProgressAnnotation);
          }

          try {
            logger.debug('Updating Context Buffer');
            dataStream.writeData({
              type: 'progress',
              label: 'context',
              status: 'in-progress',
              order: progressCounter++,
              message: 'Determining Files to Read',
            } satisfies ProgressAnnotation);

            logger.debug(`Messages count: ${messages.length}`);
            filteredFiles = await selectContext({
              messages: [...messages],
              env: context.cloudflare?.env,
              apiKeys,
              files,
              providerSettings,
              promptId,
              contextOptimization,
              summary: summary || '',
              onFinish(resp) {
                if (resp.usage) {
                  logger.debug('selectContext token usage', JSON.stringify(resp.usage));
                  cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                  cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                  cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
                }
              },
            });

            if (filteredFiles) {
              logger.debug(`files in context : ${JSON.stringify(Object.keys(filteredFiles))}`);
            }

            dataStream.writeMessageAnnotation({
              type: 'codeContext',
              files: Object.keys(filteredFiles).map((key) => {
                let path = key;

                if (path.startsWith(WORK_DIR)) {
                  path = path.replace(WORK_DIR, '');
                }

                return path;
              }),
            } as ContextAnnotation);

            dataStream.writeData({
              type: 'progress',
              label: 'context',
              status: 'complete',
              order: progressCounter++,
              message: 'Code Files Selected',
            } satisfies ProgressAnnotation);
          } catch (ctxErr: any) {
            logger.warn(`Context selection failed, using all files: ${ctxErr?.message}`);
            dataStream.writeData({
              type: 'progress',
              label: 'context',
              status: 'complete',
              order: progressCounter++,
              message: 'Skipped (error)',
            } satisfies ProgressAnnotation);
          }
        } else if (isLocalProvider && contextOptimization) {
          // For local providers: use fast deterministic context tracking (no LLM call, no delay)
          const localCtx = buildLocalContext(messages);

          if (localCtx) {
            summary = localCtx;
            logger.info(`[LocalCtx] Built fast context for ${targetProviderName}/${targetModel}`);
            dataStream.writeData({
              type: 'progress',
              label: 'summary',
              status: 'complete',
              order: progressCounter++,
              message: 'Context tracked (local fast-path)',
            } satisfies ProgressAnnotation);
          } else {
            dataStream.writeData({
              type: 'progress',
              label: 'summary',
              status: 'complete',
              order: progressCounter++,
              message: 'No prior context',
            } satisfies ProgressAnnotation);
          }
        }

        const options: StreamingOptions = {
          toolChoice: 'none',
          onFinish: async ({ text: content, finishReason, usage }) => {
            logger.debug('usage', JSON.stringify(usage));

            if (usage) {
              cumulativeUsage.completionTokens += usage.completionTokens || 0;
              cumulativeUsage.promptTokens += usage.promptTokens || 0;
              cumulativeUsage.totalTokens += usage.totalTokens || 0;
            }

            logger.info(
              `onFinish: reason=${finishReason}, tokens=${usage?.completionTokens ?? '?'}, segments=${stream.switches}`,
            );

            const hasUnclosedArtifact = content.includes('<boltArtifact') && !content.includes('</boltArtifact>');
            const hasUnclosedAction =
              content.includes('<boltAction') &&
              content.split('<boltAction').length > content.split('</boltAction>').length;

            const fileActionCount = (content.match(/<boltAction[^>]*type="file"/g) || []).length;
            const hasShellAction = content.includes('type="shell"');
            const hasStartAction = content.includes('type="start"');
            const hasArtifact = content.includes('<boltArtifact');
            const isFirstSegment = stream.switches === 0;
            const tooFewFiles =
              hasArtifact && isFirstSegment && fileActionCount < 4 && (!hasShellAction || !hasStartAction);

            const isIncomplete = hasUnclosedArtifact || hasUnclosedAction || tooFewFiles;

            if (tooFewFiles) {
              logger.warn(
                `Incomplete project detected: only ${fileActionCount} files, shell=${hasShellAction}, start=${hasStartAction}. Forcing continuation.`,
              );
            }

            if (finishReason !== 'length' && !isIncomplete) {
              dataStream.writeMessageAnnotation({
                type: 'usage',
                value: {
                  completionTokens: cumulativeUsage.completionTokens,
                  promptTokens: cumulativeUsage.promptTokens,
                  totalTokens: cumulativeUsage.totalTokens,
                },
              });
              dataStream.writeData({
                type: 'progress',
                label: 'response',
                status: 'complete',
                order: progressCounter++,
                message: 'Response Generated',
              } satisfies ProgressAnnotation);
              await new Promise((resolve) => setTimeout(resolve, 0));

              return;
            }

            if (isIncomplete && finishReason !== 'length') {
              logger.warn(
                `Model stopped early (finishReason=${finishReason}, files=${fileActionCount}). Forcing continuation.`,
              );
            }

            if (stream.switches >= MAX_RESPONSE_SEGMENTS) {
              throw Error('Cannot continue message: Maximum segments reached');
            }

            const switchesLeft = MAX_RESPONSE_SEGMENTS - stream.switches;

            logger.info(`Reached max token limit (${MAX_TOKENS}): Continuing message (${switchesLeft} switches left)`);

            const lastUserMessage = messages.filter((x) => x.role == 'user').slice(-1)[0];
            const { model, provider } = extractPropertiesFromMessage(lastUserMessage);
            messages.push({ id: generateId(), role: 'assistant', content });
            messages.push({
              id: generateId(),
              role: 'user',
              content: `[Model: ${model}]\n\n[Provider: ${provider}]\n\n${CONTINUE_PROMPT}`,
            });

            const result = await streamText({
              messages,
              env: context.cloudflare?.env,
              options,
              apiKeys,
              files,
              providerSettings,
              promptId,
              contextOptimization,
              contextFiles: filteredFiles,
              summary,
              messageSliceId,
            });

            result.mergeIntoDataStream(dataStream);

            (async () => {
              for await (const part of result.fullStream) {
                if (part.type === 'error') {
                  const error: any = part.error;
                  logger.error(`LLM stream error: ${error?.message || JSON.stringify(error)}`);

                  return;
                }
              }
            })();

            return;
          },
        };

        dataStream.writeData({
          type: 'progress',
          label: 'response',
          status: 'in-progress',
          order: progressCounter++,
          message: 'Generating Response',
        } satisfies ProgressAnnotation);

        const result = await streamText({
          messages,
          env: context.cloudflare?.env,
          options,
          apiKeys,
          files,
          providerSettings,
          promptId,
          contextOptimization,
          contextFiles: filteredFiles,
          summary,
          messageSliceId,
        });

        (async () => {
          for await (const part of result.fullStream) {
            if (part.type === 'error') {
              const error: any = part.error;
              logger.error(`LLM stream error: ${error?.message || JSON.stringify(error)}`);

              return;
            }
          }
        })();
        result.mergeIntoDataStream(dataStream);
      },
      onError: (error: any) => {
        const msg = error?.message || JSON.stringify(error);
        logger.error(`LLM onError: ${msg}`);

        return `Custom error: ${msg}`;
      },
    }).pipeThrough(
      new TransformStream({
        transform: (chunk, controller) => {
          if (!lastChunk) {
            lastChunk = ' ';
          }

          if (typeof chunk === 'string') {
            if (chunk.startsWith('g') && !lastChunk.startsWith('g')) {
              controller.enqueue(encoder.encode(`0: "<div class=\\"__boltThought__\\">"\n`));
            }

            if (lastChunk.startsWith('g') && !chunk.startsWith('g')) {
              controller.enqueue(encoder.encode(`0: "</div>\\n"\n`));
            }
          }

          lastChunk = chunk;

          let transformedChunk = chunk;

          if (typeof chunk === 'string' && chunk.startsWith('g')) {
            let content = chunk.split(':').slice(1).join(':');

            if (content.endsWith('\n')) {
              content = content.slice(0, content.length - 1);
            }

            transformedChunk = `0:${content}\n`;
          }

          // Convert the string stream to a byte stream
          const str = typeof transformedChunk === 'string' ? transformedChunk : JSON.stringify(transformedChunk);
          controller.enqueue(encoder.encode(str));
        },
      }),
    );

    return new Response(dataStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
        'Text-Encoding': 'chunked',
      },
    });
  } catch (error: any) {
    logger.error(`Chat action failed: ${error?.message || error?.statusText || JSON.stringify(error)}`);

    if (error.message?.includes('API key')) {
      throw new Response('Invalid or missing API key', {
        status: 401,
        statusText: 'Unauthorized',
      });
    }

    throw new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}
