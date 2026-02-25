import { useStore } from '@nanostores/react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { logStore, type LogEntry } from '~/lib/stores/logs';
import { classNames } from '~/utils/classNames';

const LEVEL_CONFIG: Record<string, { color: string; bg: string; icon: string }> = {
  error: { color: 'text-red-400', bg: 'bg-red-500/10', icon: 'i-ph:x-circle' },
  warning: { color: 'text-yellow-400', bg: 'bg-yellow-500/10', icon: 'i-ph:warning' },
  info: { color: 'text-blue-400', bg: 'bg-blue-500/10', icon: 'i-ph:info' },
  debug: { color: 'text-gray-400', bg: 'bg-gray-500/10', icon: 'i-ph:bug' },
};

const CATEGORY_COLORS: Record<string, string> = {
  system: 'text-purple-400',
  provider: 'text-cyan-400',
  api: 'text-green-400',
  error: 'text-red-400',
  auth: 'text-yellow-400',
  database: 'text-orange-400',
  network: 'text-teal-400',
  performance: 'text-pink-400',
  settings: 'text-indigo-400',
  user: 'text-blue-400',
  task: 'text-emerald-400',
  update: 'text-violet-400',
  feature: 'text-amber-400',
};

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function LogPanel() {
  const logsMap = useStore(logStore.logs);
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState<string>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLogCountRef = useRef(0);

  const allLogs = Object.values(logsMap).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const filteredLogs = filter === 'all' ? allLogs : allLogs.filter((l) => l.level === filter);

  const errorCount = allLogs.filter((l) => l.level === 'error').length;
  const warnCount = allLogs.filter((l) => l.level === 'warning').length;

  useEffect(() => {
    if (autoScroll && scrollRef.current && allLogs.length !== prevLogCountRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }

    prevLogCountRef.current = allLogs.length;
  }, [allLogs.length, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) {
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  }, []);

  return (
    <>
      {/* Toggle Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={classNames(
          'fixed top-3 right-3 z-[9999] flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium',
          'border backdrop-blur-md transition-all duration-200',
          isOpen
            ? 'bg-bolt-elements-background-depth-2/95 border-purple-500/40 text-purple-400 shadow-lg shadow-purple-500/10'
            : 'bg-bolt-elements-background-depth-1/80 border-bolt-elements-borderColor/50 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:border-purple-500/30',
        )}
        title="Логи системы"
      >
        <div className="i-ph:terminal-window w-4 h-4" />
        {!isOpen && (errorCount > 0 || warnCount > 0) && (
          <span className="flex items-center gap-1">
            {errorCount > 0 && <span className="text-red-400 font-bold">{errorCount}</span>}
            {warnCount > 0 && <span className="text-yellow-400 font-bold">{warnCount}</span>}
          </span>
        )}
        {isOpen && <span>Логи</span>}
      </button>

      {/* Log Panel */}
      {isOpen && (
        <div
          className={classNames(
            'fixed top-12 right-3 z-[9998] w-[480px] max-h-[70vh] flex flex-col',
            'bg-bolt-elements-background-depth-1/95 backdrop-blur-lg',
            'border border-bolt-elements-borderColor/60 rounded-xl',
            'shadow-2xl shadow-black/30',
            'animate-in slide-in-from-top-2 fade-in duration-200',
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-bolt-elements-borderColor/40">
            <div className="flex items-center gap-2">
              <div className="i-ph:list-bullets text-purple-400 w-4 h-4" />
              <span className="text-xs font-semibold text-bolt-elements-textPrimary">Логи ({filteredLogs.length})</span>
              {errorCount > 0 && (
                <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-red-500/20 text-red-400">
                  {errorCount} err
                </span>
              )}
              {warnCount > 0 && (
                <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-yellow-500/20 text-yellow-400">
                  {warnCount} warn
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {/* Filter buttons */}
              {(['all', 'error', 'warning', 'info', 'debug'] as const).map((level) => (
                <button
                  key={level}
                  onClick={() => setFilter(level)}
                  className={classNames(
                    'px-1.5 py-0.5 text-[10px] font-medium rounded transition-all',
                    filter === level
                      ? 'bg-purple-500/20 text-purple-400'
                      : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary',
                  )}
                >
                  {level === 'all'
                    ? 'Все'
                    : level === 'error'
                      ? 'Err'
                      : level === 'warning'
                        ? 'Warn'
                        : level === 'info'
                          ? 'Info'
                          : 'Debug'}
                </button>
              ))}
              <div className="w-px h-3 bg-bolt-elements-borderColor/40 mx-1" />
              <button
                onClick={() => logStore.clearLogs()}
                className="text-bolt-elements-textTertiary hover:text-red-400 transition-colors p-0.5"
                title="Очистить логи"
              >
                <div className="i-ph:trash w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary transition-colors p-0.5"
                title="Закрыть"
              >
                <div className="i-ph:x w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Log entries */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto min-h-0 max-h-[calc(70vh-44px)]"
          >
            {filteredLogs.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-bolt-elements-textTertiary text-xs">
                Нет логов
              </div>
            ) : (
              <div className="divide-y divide-bolt-elements-borderColor/20">
                {filteredLogs.map((log) => (
                  <LogRow key={log.id} log={log} />
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          {!autoScroll && filteredLogs.length > 0 && (
            <button
              onClick={() => {
                setAutoScroll(true);

                if (scrollRef.current) {
                  scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                }
              }}
              className="flex items-center justify-center gap-1 py-1 text-[10px] text-purple-400 hover:text-purple-300 border-t border-bolt-elements-borderColor/40 transition-colors"
            >
              <div className="i-ph:arrow-down w-3 h-3" />
              Прокрутить вниз
            </button>
          )}
        </div>
      )}
    </>
  );
}

function LogRow({ log }: { log: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const config = LEVEL_CONFIG[log.level] || LEVEL_CONFIG.info;
  const catColor = CATEGORY_COLORS[log.category] || 'text-gray-400';

  return (
    <div
      className={classNames(
        'px-3 py-1.5 hover:bg-bolt-elements-background-depth-2/50 cursor-pointer transition-colors text-[11px] leading-relaxed',
        config.bg,
      )}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-1.5">
        <div className={classNames(config.icon, config.color, 'w-3 h-3 mt-0.5 flex-shrink-0')} />
        <span className="text-bolt-elements-textTertiary flex-shrink-0 font-mono">{formatTime(log.timestamp)}</span>
        <span className={classNames('flex-shrink-0 font-medium', catColor)}>[{log.category}]</span>
        <span className="text-bolt-elements-textPrimary break-all flex-1">{log.message}</span>
      </div>

      {expanded && log.details && (
        <pre className="mt-1 ml-5 p-2 rounded bg-bolt-elements-background-depth-3/80 text-[10px] text-bolt-elements-textSecondary overflow-x-auto max-h-32 whitespace-pre-wrap break-all">
          {JSON.stringify(log.details, null, 2)}
        </pre>
      )}
    </div>
  );
}
