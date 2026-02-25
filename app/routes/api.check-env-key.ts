import type { LoaderFunction } from '@remix-run/cloudflare';
import { LLMManager } from '~/lib/modules/llm/manager';
import { getApiKeysFromCookie } from '~/lib/api/cookies';

export const loader: LoaderFunction = async ({ context, request }) => {
  const url = new URL(request.url);
  const provider = url.searchParams.get('provider');

  if (!provider) {
    return Response.json({ isSet: false });
  }

  const llmManager = LLMManager.getInstance(context?.cloudflare?.env as any);
  const providerInstance = llmManager.getProvider(provider);

  if (!providerInstance) {
    return Response.json({ isSet: false });
  }

  const envVarName = providerInstance.config.apiTokenKey;
  const baseUrlKey = providerInstance.config.baseUrlKey;

  // Local providers (Ollama, LMStudio, etc.) use baseUrl, not API keys
  if (!envVarName && baseUrlKey) {
    const baseUrlSet = !!(
      (context?.cloudflare?.env as Record<string, any>)?.[baseUrlKey] ||
      process.env[baseUrlKey] ||
      llmManager.env[baseUrlKey] ||
      providerInstance.config.baseUrl
    );

    return Response.json({ isSet: baseUrlSet, isLocal: true });
  }

  if (!envVarName) {
    return Response.json({ isSet: false });
  }

  // Get API keys from cookie
  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = getApiKeysFromCookie(cookieHeader);

  const isSet = !!(
    apiKeys?.[provider] ||
    (context?.cloudflare?.env as Record<string, any>)?.[envVarName] ||
    process.env[envVarName] ||
    llmManager.env[envVarName]
  );

  return Response.json({ isSet });
};
