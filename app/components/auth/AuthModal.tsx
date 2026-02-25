import { useState, useCallback } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { motion } from 'framer-motion';
import { toast } from 'react-toastify';
import { signIn, signUp } from '~/lib/stores/appwrite';
import { fullSync } from '~/lib/persistence/sync';
import { dialogBackdropVariants, dialogVariants } from '~/components/ui/Dialog';
import { classNames } from '~/utils/classNames';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type AuthMode = 'login' | 'register';

export function AuthModal({ isOpen, onClose, onSuccess }: AuthModalProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setLoading(true);

      try {
        if (mode === 'register') {
          if (password.length < 8) {
            toast.error('Пароль должен быть минимум 8 символов');
            setLoading(false);
            return;
          }

          await signUp(email, password, name || undefined);
          toast.success('Аккаунт создан!');
        } else {
          await signIn(email, password);
          toast.success('Вы вошли в систему');
        }

        // Sync chats bidirectionally (non-blocking toast)
        fullSync()
          .then(({ pulled, pushed }) => {
            if (pulled > 0) {
              toast.info(`Загружено ${pulled} чатов из облака`);
            }
          })
          .catch(() => {});

        onSuccess();
        onClose();
      } catch (error: any) {
        const msg = error?.message || 'Ошибка авторизации';

        if (msg.includes('Invalid credentials') || msg.includes('not found')) {
          toast.error('Неверный email или пароль');
        } else if (msg.includes('already exists')) {
          toast.error('Пользователь с таким email уже существует');
        } else {
          toast.error(msg);
        }
      } finally {
        setLoading(false);
      }
    },
    [mode, email, password, name, onSuccess, onClose],
  );

  const resetForm = () => {
    setEmail('');
    setPassword('');
    setName('');
  };

  const toggleMode = () => {
    setMode((prev) => (prev === 'login' ? 'register' : 'login'));
    resetForm();
  };

  return (
    <RadixDialog.Root open={isOpen} onOpenChange={onClose}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay asChild>
          <motion.div
            className="fixed inset-0 z-[9999] bg-black/70 dark:bg-black/80 backdrop-blur-sm"
            initial="closed"
            animate="open"
            exit="closed"
            variants={dialogBackdropVariants}
          />
        </RadixDialog.Overlay>
        <RadixDialog.Content asChild>
          <motion.div
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-gray-950 rounded-xl shadow-2xl border border-bolt-elements-borderColor z-[9999] w-[420px] focus:outline-none overflow-hidden"
            initial="closed"
            animate="open"
            exit="closed"
            variants={dialogVariants}
          >
            {/* Header */}
            <div className="px-6 pt-6 pb-4">
              <div className="flex items-center gap-3 mb-1">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center">
                  <div className="i-ph:user-circle-fill text-white text-xl" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-bolt-elements-textPrimary">
                    {mode === 'login' ? 'Вход' : 'Регистрация'}
                  </h2>
                  <p className="text-xs text-bolt-elements-textSecondary">
                    {mode === 'login' ? 'Войдите в свой аккаунт' : 'Создайте новый аккаунт'}
                  </p>
                </div>
              </div>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="px-6 pb-6">
              <div className="space-y-3">
                {mode === 'register' && (
                  <div>
                    <label className="block text-xs font-medium text-bolt-elements-textSecondary mb-1">
                      Имя
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-lg text-sm bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor text-bolt-elements-textPrimary focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 transition-all"
                      placeholder="Ваше имя"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-bolt-elements-textSecondary mb-1">
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 rounded-lg text-sm bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor text-bolt-elements-textPrimary focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 transition-all"
                    placeholder="email@example.com"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-bolt-elements-textSecondary mb-1">
                    Пароль
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    className="w-full px-3 py-2.5 rounded-lg text-sm bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor text-bolt-elements-textPrimary focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 transition-all"
                    placeholder={mode === 'register' ? 'Минимум 8 символов' : '••••••••'}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className={classNames(
                  'w-full mt-5 py-2.5 rounded-lg text-sm font-medium transition-all',
                  'bg-purple-500 text-white hover:bg-purple-600',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  'flex items-center justify-center gap-2',
                )}
              >
                {loading && <div className="i-ph:spinner-gap-bold animate-spin w-4 h-4" />}
                {mode === 'login' ? 'Войти' : 'Создать аккаунт'}
              </button>

              <div className="mt-4 text-center">
                <button
                  type="button"
                  onClick={toggleMode}
                  className="text-xs text-bolt-elements-textSecondary hover:text-purple-500 transition-colors"
                >
                  {mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
                </button>
              </div>
            </form>

            {/* Close */}
            <RadixDialog.Close asChild>
              <button className="absolute top-4 right-4 text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary transition-colors">
                <div className="i-ph:x w-4 h-4" />
              </button>
            </RadixDialog.Close>
          </motion.div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
