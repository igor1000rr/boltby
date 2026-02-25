import { useState, useCallback, useRef, useEffect } from 'react';
import { useStore } from '@nanostores/react';
import { appwriteUser, signOut, appwriteConnection } from '~/lib/stores/appwrite';
import { AuthModal } from './AuthModal';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';

export function UserMenu() {
  const user = useStore(appwriteUser);
  const connection = useStore(appwriteConnection);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleSignOut = useCallback(async () => {
    try {
      await signOut();
      setShowDropdown(false);
      toast.success('Вы вышли из системы');
    } catch {
      toast.error('Ошибка при выходе');
    }
  }, []);

  // If Appwrite not configured, don't show anything
  if (!connection.endpoint || !connection.isConnected) {
    return null;
  }

  // Not logged in — show login button
  if (!user) {
    return (
      <>
        <button
          onClick={() => setShowAuthModal(true)}
          className={classNames(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
            'bg-purple-500/10 text-purple-500 hover:bg-purple-500/20',
            'border border-purple-500/20',
          )}
        >
          <div className="i-ph:sign-in w-3.5 h-3.5" />
          Войти
        </button>
        <AuthModal
          isOpen={showAuthModal}
          onClose={() => setShowAuthModal(false)}
          onSuccess={() => setShowAuthModal(false)}
        />
      </>
    );
  }

  // Logged in — show avatar/menu
  const initials = (user.name || user.email || '?')
    .split(' ')
    .map((s) => s[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setShowDropdown((v) => !v)}
        className={classNames(
          'flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all',
          'hover:bg-bolt-elements-background-depth-2',
          showDropdown && 'bg-bolt-elements-background-depth-2',
        )}
      >
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center text-white text-[10px] font-bold">
          {initials}
        </div>
        <span className="text-xs text-bolt-elements-textSecondary hidden sm:block max-w-[100px] truncate">
          {user.name || user.email}
        </span>
        <div className="i-ph:caret-down w-3 h-3 text-bolt-elements-textTertiary" />
      </button>

      {showDropdown && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-gray-950 rounded-lg shadow-xl border border-bolt-elements-borderColor z-50 py-1 overflow-hidden">
          {/* User info */}
          <div className="px-3 py-2.5 border-b border-bolt-elements-borderColor">
            <p className="text-sm font-medium text-bolt-elements-textPrimary truncate">
              {user.name || 'Пользователь'}
            </p>
            <p className="text-xs text-bolt-elements-textSecondary truncate">{user.email}</p>
          </div>

          {/* Sign out */}
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
          >
            <div className="i-ph:sign-out w-3.5 h-3.5" />
            Выйти
          </button>
        </div>
      )}
    </div>
  );
}
