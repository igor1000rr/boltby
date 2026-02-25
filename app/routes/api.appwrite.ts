import { type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';

/*
 * VITE_APPWRITE_ENDPOINT includes /v1 (e.g., https://domain.com/v1)
 * For server-side REST, we use this directly since Appwrite SDK paths are relative to /v1
 */
const APPWRITE_ENDPOINT = process.env.VITE_APPWRITE_ENDPOINT || '';
const APPWRITE_PROJECT_ID = process.env.VITE_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID || '';
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY || '';

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'health') {
    if (!APPWRITE_ENDPOINT) {
      return Response.json({ ok: false, error: 'Appwrite endpoint not configured' }, { status: 503 });
    }

    try {
      const resp = await fetch(`${APPWRITE_ENDPOINT}/health`, {
        signal: AbortSignal.timeout(5000),
        headers: {
          'X-Appwrite-Project': APPWRITE_PROJECT_ID,
        },
      });
      const data = (await resp.json()) as Record<string, unknown>;

      return Response.json({ ok: resp.ok, ...data });
    } catch (error: any) {
      return Response.json({ ok: false, error: error.message }, { status: 503 });
    }
  }

  if (action === 'config') {
    return Response.json({
      endpoint: APPWRITE_ENDPOINT,
      projectId: APPWRITE_PROJECT_ID,
      configured: Boolean(APPWRITE_ENDPOINT && APPWRITE_PROJECT_ID),
    });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (!APPWRITE_ENDPOINT || !APPWRITE_API_KEY) {
    return Response.json({ ok: false, error: 'Appwrite not configured on server' }, { status: 503 });
  }

  const body = await request.json<{ path: string; method?: string; data?: any }>();
  const { path, method = 'GET', data } = body;

  // Only allow safe API paths (relative to /v1 endpoint)
  const allowedPrefixes = ['/databases', '/users', '/health'];

  if (!allowedPrefixes.some((prefix) => path.startsWith(prefix))) {
    return Response.json({ ok: false, error: `Forbidden path: ${path}` }, { status: 403 });
  }

  try {
    const resp = await fetch(`${APPWRITE_ENDPOINT}${path}`, {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'X-Appwrite-Project': APPWRITE_PROJECT_ID,
        'X-Appwrite-Key': APPWRITE_API_KEY,
      },
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(10000),
    });

    const result = await resp.json();

    return Response.json(result, { status: resp.status });
  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 503 });
  }
}
