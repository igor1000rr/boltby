import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '@nanostores/react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';
import {
  gpuNodes,
  activeNodeId,
  gpuNodesLoading,
  initGpuNodes,
  addNode,
  removeNode,
  updateNode,
  checkNode,
  checkAllNodes,
  setActiveNode,
  getNodeModels,
  pullModelOnNode,
  getPullStatus,
  getSetupCommand,
  pollPendingNodes,
  loadFromAppwrite,
  type GpuNode,
  type GpuNodeModel,
} from '~/lib/stores/gpu-nodes';
import { appwriteUser } from '~/lib/stores/appwrite';

// ─── Add/Edit Form ───

interface NodeFormData {
  name: string;
  host: string;
  port: string;
  provider: 'ollama' | 'lmstudio';
  isPublic: boolean;
}

const EMPTY_FORM: NodeFormData = { name: '', host: '', port: '11434', provider: 'ollama', isPublic: true };

function NodeForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  initial: NodeFormData;
  onSubmit: (data: NodeFormData) => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  const [form, setForm] = useState<NodeFormData>(initial);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const testConnection = async () => {
    if (!form.host) {
      return;
    }

    setTesting(true);
    setTestResult(null);

    try {
      const resp = await fetch(
        `/api/gpu-nodes?action=check&host=${encodeURIComponent(form.host)}&port=${encodeURIComponent(form.port || '11434')}`,
      );
      const data = (await resp.json()) as { ok: boolean; latency?: number; modelCount?: number; error?: string };

      if (data.ok) {
        setTestResult({ ok: true, message: `Подключено! ${data.modelCount} моделей, ${data.latency}ms` });
      } else {
        setTestResult({ ok: false, message: data.error || 'Недоступен' });
      }
    } catch (e: any) {
      setTestResult({ ok: false, message: e.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="bg-bolt-elements-background-depth-2 rounded-lg p-4 border border-bolt-elements-borderColor space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-bolt-elements-textSecondary mb-1">Название</label>
          <input
            type="text"
            placeholder="Мой PC с 5090"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 rounded-md bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor text-bolt-elements-textPrimary text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-bolt-elements-textSecondary mb-1">Провайдер</label>
          <select
            value={form.provider}
            onChange={(e) =>
              setForm({
                ...form,
                provider: e.target.value as 'ollama' | 'lmstudio',
                port: e.target.value === 'lmstudio' ? '1234' : '11434',
              })
            }
            className="w-full px-3 py-2 rounded-md bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor text-bolt-elements-textPrimary text-sm"
          >
            <option value="ollama">Ollama</option>
            <option value="lmstudio">LM Studio</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-bolt-elements-textSecondary mb-1">Хост (IP / домен)</label>
          <input
            type="text"
            placeholder="10.7.0.2"
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
            className="w-full px-3 py-2 rounded-md bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor text-bolt-elements-textPrimary text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-bolt-elements-textSecondary mb-1">Порт</label>
          <input
            type="text"
            placeholder="11434"
            value={form.port}
            onChange={(e) => setForm({ ...form, port: e.target.value })}
            className="w-full px-3 py-2 rounded-md bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor text-bolt-elements-textPrimary text-sm"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="node-public"
          checked={form.isPublic}
          onChange={(e) => setForm({ ...form, isPublic: e.target.checked })}
          className="rounded"
        />
        <label htmlFor="node-public" className="text-sm text-bolt-elements-textSecondary">
          Доступна всем пользователям
        </label>
      </div>

      {testResult && (
        <div
          className={classNames(
            'text-xs px-3 py-2 rounded-md',
            testResult.ok
              ? 'bg-green-500/10 text-green-400 border border-green-500/20'
              : 'bg-red-500/10 text-red-400 border border-red-500/20',
          )}
        >
          {testResult.ok ? '✅' : '❌'} {testResult.message}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={testConnection}
          disabled={testing || !form.host}
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary border border-bolt-elements-borderColor transition-colors disabled:opacity-50"
        >
          {testing ? (
            <span className="flex items-center gap-1.5">
              <span className="i-ph:spinner animate-spin" /> Проверка...
            </span>
          ) : (
            'Проверить соединение'
          )}
        </button>
        <div className="flex-1" />
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-md text-sm text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"
        >
          Отмена
        </button>
        <button
          onClick={() => {
            if (!form.name || !form.host) {
              toast.error('Укажи название и хост');
              return;
            }

            onSubmit(form);
          }}
          className="px-4 py-1.5 rounded-md text-sm font-medium bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

// ─── Node Card ───

function NodeCard({
  node,
  isActive,
  isOwner,
  onActivate,
  onCheck,
  onDelete,
  onEdit,
  onShowModels,
}: {
  node: GpuNode;
  isActive: boolean;
  isOwner: boolean;
  onActivate: () => void;
  onCheck: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onShowModels: () => void;
}) {
  const [checking, setChecking] = useState(false);

  const handleCheck = async () => {
    setChecking(true);
    await onCheck();
    setChecking(false);
  };

  const statusColor =
    node.status === 'online' ? 'bg-green-500' : node.status === 'offline' ? 'bg-red-500' : 'bg-yellow-500';

  const statusText = node.status === 'online' ? 'Online' : node.status === 'offline' ? 'Offline' : 'Не проверено';

  return (
    <div
      className={classNames(
        'rounded-lg border p-4 transition-all',
        isActive
          ? 'border-purple-500/50 bg-purple-500/5 ring-1 ring-purple-500/20'
          : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 hover:border-bolt-elements-borderColor/80',
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div
              className={classNames(
                'w-10 h-10 rounded-lg flex items-center justify-center text-lg',
                isActive
                  ? 'bg-purple-500/20 text-purple-400'
                  : 'bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary',
              )}
            >
              {node.provider === 'ollama' ? '🦙' : '🖥️'}
            </div>
            <div
              className={classNames(
                'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-bolt-elements-background-depth-2',
                statusColor,
              )}
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-bolt-elements-textPrimary">{node.name}</span>
              {isActive && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 uppercase">
                  Активна
                </span>
              )}
              {node.isPublic && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary">
                  Общая
                </span>
              )}
            </div>
            <div className="text-xs text-bolt-elements-textTertiary mt-0.5">
              {node.host}:{node.port} · {node.provider === 'ollama' ? 'Ollama' : 'LM Studio'}
              {node.addedByName && !isOwner && <span> · от {node.addedByName}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      {node.status !== 'unknown' && (
        <div className="flex gap-4 mt-3 text-xs text-bolt-elements-textTertiary">
          <span className="flex items-center gap-1">
            <span className={classNames('w-1.5 h-1.5 rounded-full', statusColor)} />
            {statusText}
          </span>
          {node.latency > 0 && <span>{node.latency}ms</span>}
          {node.modelCount > 0 && <span>{node.modelCount} моделей</span>}
          {node.lastChecked && (
            <span>{new Date(node.lastChecked).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</span>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-1.5 mt-3 flex-wrap">
        <button
          onClick={handleCheck}
          disabled={checking}
          className="px-2.5 py-1 rounded text-xs font-medium bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary border border-bolt-elements-borderColor transition-colors disabled:opacity-50"
        >
          {checking ? '⏳' : '🔍'} Проверить
        </button>
        {node.status === 'online' && (
          <button
            onClick={onShowModels}
            className="px-2.5 py-1 rounded text-xs font-medium bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary border border-bolt-elements-borderColor transition-colors"
          >
            📋 Модели
          </button>
        )}
        {!isActive ? (
          <button
            onClick={onActivate}
            className="px-2.5 py-1 rounded text-xs font-medium bg-green-500/10 text-green-400 hover:bg-green-500/20 border border-green-500/20 transition-colors"
          >
            ✅ Использовать
          </button>
        ) : (
          <button
            onClick={() => setActiveNode(null)}
            className="px-2.5 py-1 rounded text-xs font-medium bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary border border-bolt-elements-borderColor transition-colors"
          >
            Отключить
          </button>
        )}
        {isOwner && (
          <>
            <button
              onClick={onEdit}
              className="px-2.5 py-1 rounded text-xs text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary transition-colors"
            >
              ✏️
            </button>
            <button
              onClick={onDelete}
              className="px-2.5 py-1 rounded text-xs text-red-400/60 hover:text-red-400 transition-colors"
            >
              🗑️
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Models Modal ───

function ModelsModal({ node, onClose }: { node: GpuNode; onClose: () => void }) {
  const [models, setModels] = useState<GpuNodeModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [pullName, setPullName] = useState('');
  const [pulling, setPulling] = useState<
    Record<string, { status: string; percent: number; done: boolean; error: string }>
  >({});
  const pollTimers = useRef<Record<string, NodeJS.Timeout>>({});

  const SUGGESTED = [
    { name: 'qwen2.5-coder:32b', desc: 'Лучший для кода', vram: '20GB+' },
    { name: 'qwen2.5-coder:14b', desc: 'Быстрый', vram: '10GB+' },
    { name: 'qwen2.5-coder:7b', desc: 'Компактный', vram: '6GB+' },
    { name: 'qwen3-coder:30b-a3b', desc: 'MoE 30B', vram: '12GB+' },
    { name: 'devstral:24b', desc: 'Mistral код', vram: '16GB+' },
    { name: 'deepseek-r1:14b', desc: 'Reasoning', vram: '10GB+' },
  ];

  const refresh = useCallback(() => {
    setLoading(true);
    getNodeModels(node.id).then((m) => {
      setModels(m);
      setLoading(false);
    });
  }, [node.id]);

  useEffect(() => {
    refresh();

    return () => {
      Object.values(pollTimers.current).forEach(clearInterval);
    };
  }, [refresh]);

  const startPull = useCallback(
    async (name: string) => {
      if (!name.trim()) {
        return;
      }

      setPulling((p) => ({ ...p, [name]: { status: 'starting', percent: 0, done: false, error: '' } }));

      const result = await pullModelOnNode(node.id, name);

      if (!result.ok) {
        setPulling((p) => ({
          ...p,
          [name]: { status: 'error', percent: 0, done: true, error: result.message || 'Failed' },
        }));
        toast.error(`Ошибка: ${result.message}`);

        return;
      }

      toast.info(`📥 Скачивание ${name} запущено`);

      // Poll progress
      let nullCount = 0;
      const timer = setInterval(async () => {
        const status = await getPullStatus(node.id, name);

        if (!status) {
          nullCount++;

          // If server lost track of this job (cleaned up), stop polling
          if (nullCount >= 5) {
            clearInterval(timer);
            delete pollTimers.current[name];
            setPulling((p) => ({
              ...p,
              [name]: { status: 'unknown', percent: 0, done: true, error: 'Потеряна связь с сервером' },
            }));
          }

          return;
        }

        nullCount = 0;
        setPulling((p) => ({ ...p, [name]: status }));

        if (status.done) {
          clearInterval(timer);
          delete pollTimers.current[name];

          if (status.error) {
            toast.error(`❌ ${name}: ${status.error}`);
          } else {
            toast.success(`✅ ${name} установлена!`);
            refresh();
          }
        }
      }, 2000);

      pollTimers.current[name] = timer;
    },
    [node.id, refresh],
  );

  const installedNames = new Set(models.map((m) => m.name));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-bolt-elements-background-depth-1 rounded-xl border border-bolt-elements-borderColor shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-bolt-elements-borderColor shrink-0">
          <div>
            <h3 className="text-sm font-medium text-bolt-elements-textPrimary">Модели — {node.name}</h3>
            <p className="text-xs text-bolt-elements-textTertiary">
              {node.host}:{node.port} · {models.length} моделей
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refresh}
              className="text-xs px-2 py-1 rounded bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
            >
              🔄
            </button>
            <button onClick={onClose} className="text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary">
              ✕
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 p-4 space-y-4">
          {/* Pull input */}
          <div>
            <div className="text-xs font-semibold text-bolt-elements-textSecondary mb-2">📥 Скачать модель</div>
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 text-sm rounded-lg bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary/50 focus:border-purple-400 outline-none"
                placeholder="qwen2.5-coder:32b"
                value={pullName}
                onChange={(e) => setPullName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    startPull(pullName);
                    setPullName('');
                  }
                }}
              />
              <button
                onClick={() => {
                  startPull(pullName);
                  setPullName('');
                }}
                disabled={!pullName.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 border border-purple-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                📥 Скачать
              </button>
            </div>

            {/* Suggested */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {SUGGESTED.map((s) => (
                <button
                  key={s.name}
                  onClick={() => {
                    if (!installedNames.has(s.name) && !pulling[s.name]) {
                      startPull(s.name);
                    }
                  }}
                  disabled={installedNames.has(s.name) || (!!pulling[s.name] && !pulling[s.name].done)}
                  className={classNames(
                    'text-xs px-2 py-1 rounded-md border transition-colors',
                    installedNames.has(s.name)
                      ? 'bg-green-500/5 text-green-400/60 border-green-500/10 cursor-default'
                      : pulling[s.name] && !pulling[s.name].done
                        ? 'bg-purple-500/5 text-purple-400/60 border-purple-500/10 cursor-wait'
                        : 'bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary border-bolt-elements-borderColor hover:border-purple-400/40 hover:text-purple-400 cursor-pointer',
                  )}
                  title={`${s.desc} · ${s.vram}`}
                >
                  {installedNames.has(s.name) ? '✓ ' : ''}
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          {/* Active pulls */}
          {Object.entries(pulling).filter(([_, p]) => !p.done || p.error).length > 0 && (
            <div>
              <div className="text-xs font-semibold text-bolt-elements-textSecondary mb-2">⏳ Загрузки</div>
              <div className="space-y-2">
                {Object.entries(pulling).map(([name, p]) => {
                  if (p.done && !p.error) {
                    return null;
                  }

                  return (
                    <div
                      key={name}
                      className="px-3 py-2 rounded-lg bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-bolt-elements-textPrimary">{name}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-bolt-elements-textTertiary">
                            {p.error ? `❌ ${p.error}` : p.done ? '✅' : `${p.percent}%`}
                          </span>
                          {p.done && p.error && (
                            <button
                              onClick={() =>
                                setPulling((prev) => {
                                  const next = { ...prev };
                                  delete next[name];

                                  return next;
                                })
                              }
                              className="text-[10px] text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary"
                              title="Убрать"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                      {!p.done && (
                        <div className="h-1.5 bg-bolt-elements-background-depth-3 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-purple-500 rounded-full transition-all duration-300"
                            style={{ width: `${p.percent}%` }}
                          />
                        </div>
                      )}
                      <div className="text-[10px] text-bolt-elements-textTertiary mt-0.5">{p.status}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Installed models */}
          <div>
            <div className="text-xs font-semibold text-bolt-elements-textSecondary mb-2">
              📦 Установленные ({models.length})
            </div>
            {loading ? (
              <div className="text-center py-6 text-bolt-elements-textTertiary text-sm">Загрузка...</div>
            ) : models.length === 0 ? (
              <div className="text-center py-6 text-bolt-elements-textTertiary text-sm">
                Нет моделей. Скачай первую выше ☝️
              </div>
            ) : (
              <div className="space-y-1.5">
                {models.map((m) => (
                  <div
                    key={m.name}
                    className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-bolt-elements-textPrimary truncate">{m.name}</div>
                      <div className="text-xs text-bolt-elements-textTertiary">
                        {m.parameterSize} · {m.family} · {m.quantization}
                      </div>
                    </div>
                    <div className="text-xs text-bolt-elements-textTertiary font-mono shrink-0 ml-3">{m.sizeGB} GB</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Setup Command Section ───

function SetupCommandSection() {
  const user = useStore(appwriteUser);
  const [showCommand, setShowCommand] = useState(false);
  const [command, setCommand] = useState('');
  const [copied, setCopied] = useState(false);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const generateCommand = useCallback(() => {
    const cmd = getSetupCommand();
    setCommand(cmd);
    setShowCommand(true);
    setCopied(false);

    // Start polling for auto-registered nodes
    setPolling(true);

    if (pollRef.current) {
      clearInterval(pollRef.current);
    }

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    pollRef.current = setInterval(async () => {
      const added = await pollPendingNodes();

      if (added > 0) {
        toast.success(`🎉 ${added} GPU нода автоматически подключена!`);
        setPolling(false);

        if (pollRef.current) {
          clearInterval(pollRef.current);
        }
      }
    }, 5000);

    // Stop polling after 30 minutes
    timeoutRef.current = setTimeout(
      () => {
        setPolling(false);

        if (pollRef.current) {
          clearInterval(pollRef.current);
        }
      },
      30 * 60 * 1000,
    );
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const copyCommand = useCallback(() => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    toast.success('Команда скопирована');
    setTimeout(() => setCopied(false), 3000);
  }, [command]);

  return (
    <div className="rounded-lg bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-bolt-elements-textPrimary">Установка одной командой</h3>
          <p className="text-xs text-bolt-elements-textTertiary mt-0.5">
            Запусти на любой Linux машине с GPU — она автоматически станет GPU нодой
          </p>
        </div>
        {!showCommand && (
          <button
            onClick={generateCommand}
            disabled={!user}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-green-500/10 text-green-400 hover:bg-green-500/20 border border-green-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            🔗 Получить команду
          </button>
        )}
      </div>

      {!user && (
        <p className="text-xs text-yellow-400/80 bg-yellow-400/5 rounded px-3 py-2 border border-yellow-400/10">
          ⚠️ Войди в аккаунт чтобы генерировать команду установки
        </p>
      )}

      {showCommand && (
        <div className="space-y-3">
          <div className="relative">
            <pre className="bg-bolt-elements-background-depth-3 rounded-lg p-3 pr-20 text-xs text-green-400 font-mono overflow-x-auto border border-bolt-elements-borderColor whitespace-pre-wrap break-all">
              {command}
            </pre>
            <button
              onClick={copyCommand}
              className="absolute top-2 right-2 px-3 py-1.5 rounded-md text-xs font-medium bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary border border-bolt-elements-borderColor transition-colors"
            >
              {copied ? '✅ Скопировано' : '📋 Копировать'}
            </button>
          </div>

          {polling && (
            <div className="flex items-center gap-2 text-xs text-blue-400 bg-blue-400/5 rounded px-3 py-2 border border-blue-400/10">
              <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              Ожидание подключения ноды... (запусти команду на GPU машине)
            </div>
          )}

          <div className="text-xs text-bolt-elements-textTertiary space-y-1">
            <p>Скрипт автоматически:</p>
            <p className="ml-3">• Установит Ollama (если не установлен)</p>
            <p className="ml-3">• Откроет Ollama для внешних подключений</p>
            <p className="ml-3">• Определит GPU и предложит скачать модель</p>
            <p className="ml-3">• Зарегистрирует ноду в этом Boltby</p>
          </div>

          <div className="flex gap-2">
            <button
              onClick={generateCommand}
              className="px-3 py-1.5 rounded text-xs text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary transition-colors"
            >
              🔄 Новая команда
            </button>
            <button
              onClick={() => {
                setShowCommand(false);
                setPolling(false);

                if (pollRef.current) {
                  clearInterval(pollRef.current);
                }

                if (timeoutRef.current) {
                  clearTimeout(timeoutRef.current);
                }
              }}
              className="px-3 py-1.5 rounded text-xs text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary transition-colors"
            >
              Скрыть
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Tab ───

const GpuNodesTab = () => {
  const nodes = useStore(gpuNodes);
  const active = useStore(activeNodeId);
  const loading = useStore(gpuNodesLoading);
  const user = useStore(appwriteUser);
  const userId = user?.$id || 'local';

  const [showForm, setShowForm] = useState(false);
  const [editingNode, setEditingNode] = useState<string | null>(null);
  const [modelsNode, setModelsNode] = useState<GpuNode | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    initGpuNodes();
  }, []);

  const handleAdd = useCallback(async (data: NodeFormData) => {
    const node = await addNode(data);

    if (node) {
      toast.success(`GPU нода "${data.name}" добавлена`);
      setShowForm(false);

      // Auto-check
      checkNode(node.id);
    }
  }, []);

  const handleEdit = useCallback(async (nodeId: string, data: NodeFormData) => {
    await updateNode(nodeId, data);
    toast.success('Нода обновлена');
    setEditingNode(null);
    checkNode(nodeId);
  }, []);

  const handleDelete = useCallback(async (nodeId: string, name: string) => {
    if (!confirm(`Удалить ноду "${name}"?`)) {
      return;
    }

    await removeNode(nodeId);
    toast.success(`Нода "${name}" удалена`);
  }, []);

  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
    await loadFromAppwrite();
    await checkAllNodes();
    setRefreshing(false);
    toast.success('Все ноды проверены');
  }, []);

  const handleActivate = useCallback((nodeId: string, name: string) => {
    setActiveNode(nodeId);
    toast.success(`Активная GPU нода: ${name}`);
  }, []);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-bolt-elements-textPrimary">GPU Ноды</h2>
          <p className="text-xs text-bolt-elements-textTertiary mt-0.5">
            Подключай GPU машины с Ollama для обработки LLM запросов
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleRefreshAll}
            disabled={refreshing}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary border border-bolt-elements-borderColor transition-colors disabled:opacity-50"
          >
            {refreshing ? '⏳ Проверка...' : '🔄 Проверить все'}
          </button>
          <button
            onClick={() => {
              setShowForm(true);
              setEditingNode(null);
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 border border-purple-500/20 transition-colors"
          >
            + Добавить ноду
          </button>
        </div>
      </div>

      {/* Active node banner */}
      {active &&
        (() => {
          const activeNode = nodes.find((n) => n.id === active);

          return activeNode ? (
            <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <span className="text-lg">{activeNode.provider === 'ollama' ? '🦙' : '🖥️'}</span>
              <div className="flex-1">
                <span className="text-sm font-medium text-purple-400">{activeNode.name}</span>
                <span className="text-xs text-purple-400/60 ml-2">
                  {activeNode.host}:{activeNode.port}
                </span>
              </div>
              <span className="text-xs text-purple-400/60">LLM запросы идут сюда</span>
            </div>
          ) : null;
        })()}

      {/* Add form */}
      <AnimatePresence>
        {showForm && !editingNode && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <NodeForm
              initial={EMPTY_FORM}
              onSubmit={handleAdd}
              onCancel={() => setShowForm(false)}
              submitLabel="Добавить"
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Node list */}
      {loading && nodes.length === 0 ? (
        <div className="text-center py-12 text-bolt-elements-textTertiary text-sm">Загрузка...</div>
      ) : nodes.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-3xl mb-3">🖥️</div>
          <p className="text-sm text-bolt-elements-textTertiary">Нет GPU нод</p>
          <p className="text-xs text-bolt-elements-textTertiary mt-1">
            Добавь GPU машину с Ollama чтобы запускать LLM модели
          </p>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="mt-4 px-4 py-2 rounded-lg text-sm font-medium bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors"
            >
              + Добавить первую ноду
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {nodes.map((node) => (
            <div key={node.id}>
              {editingNode === node.id ? (
                <NodeForm
                  initial={{
                    name: node.name,
                    host: node.host,
                    port: node.port,
                    provider: node.provider,
                    isPublic: node.isPublic,
                  }}
                  onSubmit={(data) => handleEdit(node.id, data)}
                  onCancel={() => setEditingNode(null)}
                  submitLabel="Сохранить"
                />
              ) : (
                <NodeCard
                  node={node}
                  isActive={active === node.id}
                  isOwner={node.addedBy === userId}
                  onActivate={() => handleActivate(node.id, node.name)}
                  onCheck={() => checkNode(node.id)}
                  onDelete={() => handleDelete(node.id, node.name)}
                  onEdit={() => setEditingNode(node.id)}
                  onShowModels={() => setModelsNode(node)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Setup command */}
      <SetupCommandSection />

      {/* Models modal */}
      {modelsNode && <ModelsModal node={modelsNode} onClose={() => setModelsNode(null)} />}
    </div>
  );
};

(GpuNodesTab as any).tabMetadata = {
  icon: 'i-ph:gpu-fill',
  description: 'Manage remote GPU compute nodes',
  category: 'services' as const,
};

export default GpuNodesTab;
