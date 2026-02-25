import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { classNames } from '~/utils/classNames';
import { TbActivityHeartbeat } from 'react-icons/tb';
import { BsCheckCircleFill, BsXCircleFill } from 'react-icons/bs';
import { SiOllama } from 'react-icons/si';
import { BiServer, BiChip } from 'react-icons/bi';
import { FaDatabase } from 'react-icons/fa';
import type { IconType } from 'react-icons';
import { getAppwriteEndpoint } from '~/lib/stores/appwrite';

type LocalServiceName = 'Ollama' | 'LMStudio' | 'Appwrite';

type ServiceStatus = {
  service: LocalServiceName;
  status: 'online' | 'offline';
  lastChecked: string;
  url: string;
  icon: IconType;
  message?: string;
  responseTime?: number;
  models?: string[];
};

function getServiceConfigs(): Record<LocalServiceName, { url: string; icon: IconType; healthPath: string }> {
  const appwriteUrl = getAppwriteEndpoint().replace(/\/v1$/, '') || 'http://localhost:8080';

  return {
    Ollama: {
      url: 'http://127.0.0.1:11434',
      icon: SiOllama,
      healthPath: '/api/tags',
    },
    LMStudio: {
      url: 'http://127.0.0.1:1234',
      icon: BiChip,
      healthPath: '/v1/models',
    },
    Appwrite: {
      url: appwriteUrl,
      icon: FaDatabase,
      healthPath: '/v1/health',
    },
  };
}

const ServiceStatusTab = () => {
  const [serviceStatuses, setServiceStatuses] = useState<ServiceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const serviceConfigs = useMemo(() => getServiceConfigs(), []);

  const checkService = useCallback(
    async (name: LocalServiceName): Promise<ServiceStatus> => {
      const config = serviceConfigs[name];
      const startTime = performance.now();

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(config.url + config.healthPath, {
          method: 'GET',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const responseTime = performance.now() - startTime;

        let models: string[] = [];
        let message = 'Service is running';

        if (response.ok) {
          try {
            const data = (await response.json()) as Record<string, unknown>;

            if (name === 'Ollama' && Array.isArray(data.models)) {
              models = (data.models as Array<{ name: string }>).map((m) => m.name);
              message = `${models.length} model${models.length === 1 ? '' : 's'} available`;
            } else if (name === 'LMStudio' && Array.isArray(data.data)) {
              models = (data.data as Array<{ id: string }>).map((m) => m.id);
              message = `${models.length} model${models.length === 1 ? '' : 's'} loaded`;
            } else if (name === 'Appwrite') {
              message = 'Backend is running';
            }
          } catch {
            message = 'Service is running';
          }
        }

        if (!response.ok) {
          return {
            service: name,
            status: 'offline',
            lastChecked: new Date().toISOString(),
            url: config.url,
            icon: config.icon,
            message: `Service returned HTTP ${response.status}`,
            responseTime,
          };
        }

        return {
          service: name,
          status: 'online',
          lastChecked: new Date().toISOString(),
          url: config.url,
          icon: config.icon,
          message,
          responseTime,
          models,
        };
      } catch {
        return {
          service: name,
          status: 'offline',
          lastChecked: new Date().toISOString(),
          url: config.url,
          icon: config.icon,
          message: 'Service is not reachable',
          responseTime: 0,
        };
      }
    },
    [serviceConfigs],
  );

  const fetchAllStatuses = useCallback(async () => {
    setLoading(true);

    const statuses = await Promise.all(
      (Object.keys(serviceConfigs) as LocalServiceName[]).map((name) => checkService(name)),
    );

    setServiceStatuses(statuses);
    setLastRefresh(new Date());
    setLoading(false);
  }, [checkService]);

  useEffect(() => {
    fetchAllStatuses();

    const interval = setInterval(fetchAllStatuses, 30_000);

    return () => clearInterval(interval);
  }, [fetchAllStatuses]);

  return (
    <div className="space-y-6">
      <motion.div
        className="space-y-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="flex items-center justify-between gap-2 mt-8 mb-4">
          <div className="flex items-center gap-2">
            <div
              className={classNames(
                'w-8 h-8 flex items-center justify-center rounded-lg',
                'bg-bolt-elements-background-depth-3',
                'text-purple-500',
              )}
            >
              <TbActivityHeartbeat className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-md font-medium text-bolt-elements-textPrimary">Local Services</h4>
              <p className="text-sm text-bolt-elements-textSecondary">Monitor local AI servers and backend services</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-bolt-elements-textSecondary">
              Last updated: {lastRefresh.toLocaleTimeString()}
            </span>
            <button
              onClick={() => fetchAllStatuses()}
              className={classNames(
                'px-3 py-1.5 rounded-lg text-sm',
                'bg-bolt-elements-background-depth-3 hover:bg-bolt-elements-background-depth-4',
                'text-bolt-elements-textPrimary',
                'transition-all duration-200',
                'flex items-center gap-2',
                loading ? 'opacity-50 cursor-not-allowed' : '',
              )}
              disabled={loading}
            >
              <div className={`i-ph:arrows-clockwise w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span>{loading ? 'Checking...' : 'Refresh'}</span>
            </button>
          </div>
        </div>

        {loading && serviceStatuses.length === 0 ? (
          <div className="text-center py-8 text-bolt-elements-textSecondary">Checking local services...</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {serviceStatuses.map((service, index) => (
              <motion.div
                key={service.service}
                className={classNames(
                  'bg-bolt-elements-background-depth-2',
                  'hover:bg-bolt-elements-background-depth-3',
                  'transition-all duration-200',
                  'relative overflow-hidden rounded-lg',
                )}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1 }}
                whileHover={{ scale: 1.02 }}
              >
                <div className="p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div
                        className={classNames(
                          'w-10 h-10 flex items-center justify-center rounded-lg',
                          'bg-bolt-elements-background-depth-3',
                          service.status === 'online' ? 'text-green-500' : 'text-red-500',
                        )}
                      >
                        {React.createElement(service.icon, { className: 'w-6 h-6' })}
                      </div>
                      <div>
                        <h4 className="text-sm font-medium text-bolt-elements-textPrimary">{service.service}</h4>
                        <p className="text-xs text-bolt-elements-textTertiary">{service.url}</p>
                      </div>
                    </div>
                    <div
                      className={classNames(
                        'flex items-center gap-1.5',
                        service.status === 'online' ? 'text-green-500' : 'text-red-500',
                      )}
                    >
                      {service.status === 'online' ? (
                        <BsCheckCircleFill className="w-4 h-4" />
                      ) : (
                        <BsXCircleFill className="w-4 h-4" />
                      )}
                      <span className="text-xs font-medium capitalize">{service.status}</span>
                    </div>
                  </div>

                  <div className="mt-3 pt-3 border-t border-bolt-elements-borderColor">
                    <p className="text-xs text-bolt-elements-textSecondary">{service.message}</p>
                    {service.responseTime !== undefined && service.responseTime > 0 && (
                      <p className="text-xs text-bolt-elements-textTertiary mt-1">
                        Response: {Math.round(service.responseTime)}ms
                      </p>
                    )}
                    {service.models && service.models.length > 0 && (
                      <div className="mt-2">
                        <p className="text-xs text-bolt-elements-textTertiary mb-1">Models:</p>
                        <div className="flex flex-wrap gap-1">
                          {service.models.slice(0, 5).map((model) => (
                            <span
                              key={model}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary"
                            >
                              {model}
                            </span>
                          ))}
                          {service.models.length > 5 && (
                            <span className="text-[10px] px-1.5 py-0.5 text-bolt-elements-textTertiary">
                              +{service.models.length - 5} more
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}

        <div className="p-4 bg-bolt-elements-background-depth-2 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <BiServer className="w-4 h-4 text-purple-500" />
            <h5 className="text-sm font-medium text-bolt-elements-textPrimary">Quick Start Guide</h5>
          </div>
          <div className="space-y-2 text-xs text-bolt-elements-textSecondary">
            <p>
              <strong>Ollama:</strong> Install from{' '}
              <code className="text-purple-400">curl -fsSL https://ollama.com/install.sh | sh</code> then{' '}
              <code className="text-purple-400">ollama pull qwen2.5-coder:7b</code>
            </p>
            <p>
              <strong>LM Studio:</strong> Download from lmstudio.ai, enable CORS in Developer settings
            </p>
            <p>
              <strong>Appwrite:</strong> Backend service at configured endpoint (Settings → Connections)
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

ServiceStatusTab.tabMetadata = {
  icon: 'i-ph:activity-bold',
  description: 'Monitor local AI and backend services',
  category: 'services',
};

export default ServiceStatusTab;
