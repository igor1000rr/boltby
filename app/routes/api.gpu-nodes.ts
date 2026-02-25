import { type LoaderFunctionArgs } from '@remix-run/cloudflare';

/**
 * GPU Nodes API — server-side proxy for GPU node management.
 *
 * GET ?action=check&host=X&port=Y                → health check
 * GET ?action=models&host=X&port=Y               → list installed models
 * GET ?action=ps&host=X&port=Y                   → running models in VRAM
 * GET ?action=pull&host=X&port=Y&model=Z         → trigger model pull on remote Ollama
 * GET ?action=pull-status&host=X&port=Y&model=Z  → poll pull progress
 * GET ?action=desired-models                      → models this VPS Ollama provider knows about
 * GET ?action=pending&userId=X                    → auto-registered nodes from setup script
 */

function buildBaseUrl(host: string, port: string): string {
  const h = host.replace(/\/+$/, '');
  const p = port || '11434';

  // If host already contains a port (like http://10.0.0.1:11434), use as-is
  if (h.match(/:\d+$/)) {
    return h.startsWith('http') ? h : `http://${h}`;
  }

  return h.startsWith('http') ? `${h}:${p}` : `http://${h}:${p}`;
}

// In-memory pull tracking
const pullJobs = new Map<
  string,
  { status: string; progress: number; total: number; error: string; done: boolean }
>();

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const host = url.searchParams.get('host') || '';
  const port = url.searchParams.get('port') || '11434';

  if (!action) {
    return Response.json({ error: 'Missing action' }, { status: 400 });
  }

  // Host-less actions
  if (action === 'desired-models') {
    return Response.json({
      ok: true,
      models: [
        'qwen2.5-coder:32b',
        'qwen2.5-coder:14b',
        'qwen2.5-coder:7b',
        'qwen3-coder:30b-a3b',
        'devstral:24b',
        'deepseek-coder-v2:16b',
        'deepseek-r1:14b',
        'deepseek-r1:8b',
        'qwen3:8b',
      ],
    });
  }

  if (action === 'pending') {
    const userId = url.searchParams.get('userId') || '';
    const pending = ((globalThis as any).__pendingGpuNodes || []) as any[];
    const user = pending.filter((n: any) => n.userId === userId);

    if (user.length) {
      (globalThis as any).__pendingGpuNodes = pending.filter((n: any) => n.userId !== userId);
    }

    return Response.json({ ok: true, nodes: user });
  }

  if (!host) {
    return Response.json({ error: 'Missing host' }, { status: 400 });
  }

  const base = buildBaseUrl(host, port);

  switch (action) {
    // ─── Health check ───
    case 'check': {
      try {
        const t0 = Date.now();
        const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
        const ms = Date.now() - t0;

        if (r.ok) {
          const d = (await r.json()) as { models?: any[] };
          return Response.json({ ok: true, latency: ms, modelCount: d.models?.length || 0, endpoint: base });
        }

        return Response.json({ ok: false, error: `HTTP ${r.status}`, latency: ms });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.name === 'TimeoutError' ? 'Timeout 8s' : e.message });
      }
    }

    // ─── List installed models ───
    case 'models': {
      try {
        const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10000) });

        if (!r.ok) {
          return Response.json({ ok: false, error: `HTTP ${r.status}` });
        }

        const d = (await r.json()) as { models?: any[] };

        return Response.json({
          ok: true,
          models: (d.models || []).map((m: any) => ({
            name: m.name,
            size: m.size,
            sizeGB: (m.size / 1024 / 1024 / 1024).toFixed(1),
            parameterSize: m.details?.parameter_size || '',
            family: m.details?.family || '',
            quantization: m.details?.quantization_level || '',
          })),
        });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message });
      }
    }

    // ─── Running models ───
    case 'ps': {
      try {
        const r = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return Response.json({ ok: false, error: `HTTP ${r.status}` });
        return Response.json({ ok: true, ...(await r.json() as object) });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message });
      }
    }

    // ─── Trigger remote pull ───
    case 'pull': {
      const model = url.searchParams.get('model') || '';

      if (!model) {
        return Response.json({ error: 'Missing model' }, { status: 400 });
      }

      const key = `${base}::${model}`;
      const existing = pullJobs.get(key);

      if (existing && !existing.done) {
        return Response.json({ ok: true, message: 'Already pulling', status: existing });
      }

      pullJobs.set(key, { status: 'starting', progress: 0, total: 0, error: '', done: false });

      // Background pull
      (async () => {
        try {
          const r = await fetch(`${base}/api/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: model, stream: true }),
            signal: AbortSignal.timeout(3600000),
          });

          if (!r.ok || !r.body) {
            pullJobs.set(key, { status: 'error', progress: 0, total: 0, error: `HTTP ${r.status}`, done: true });
            return;
          }

          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = '';

          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              break;
            }

            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';

            for (const ln of lines) {
              if (!ln.trim()) {
                continue;
              }

              try {
                const d = JSON.parse(ln);
                const j = pullJobs.get(key);

                if (j) {
                  j.status = d.status || j.status;

                  if (d.total) {
                    j.total = d.total;
                  }

                  if (d.completed) {
                    j.progress = d.completed;
                  }

                  if (d.error) {
                    j.error = d.error;
                    j.done = true;
                  }
                }
              } catch {
                /* skip */
              }
            }
          }

          const j = pullJobs.get(key);

          if (j && !j.done) {
            j.done = true;
            j.status = 'success';
          }
        } catch (e: any) {
          pullJobs.set(key, { status: 'error', progress: 0, total: 0, error: e.message, done: true });
        }

        setTimeout(() => pullJobs.delete(key), 300000);
      })();

      return Response.json({ ok: true, message: 'Pull started' });
    }

    // ─── Poll pull progress ───
    case 'pull-status': {
      const model = url.searchParams.get('model') || '';
      const key = `${base}::${model}`;
      const j = pullJobs.get(key);

      if (!j) {
        return Response.json({ ok: true, job: null });
      }

      return Response.json({
        ok: true,
        job: { ...j, percent: j.total > 0 ? Math.round((j.progress / j.total) * 100) : 0 },
      });
    }

    default:
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
