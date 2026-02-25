import { useStore } from '@nanostores/react';
import { ClientOnly } from 'remix-utils/client-only';
import { chatStore } from '~/lib/stores/chat';
import { classNames } from '~/utils/classNames';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ChatDescription } from '~/lib/persistence/ChatDescription.client';
import { UserMenu } from '~/components/auth/UserMenu';

export function Header() {
  const chat = useStore(chatStore);

  return (
    <header
      className={classNames(
        'flex items-center p-5 h-[var(--header-height)] relative',
        'border-b backdrop-blur-sm transition-all duration-500',
        {
          'border-transparent': !chat.started,
          'border-[rgba(255,215,0,0.1)]': chat.started,
        },
      )}
      style={{
        background: chat.started ? 'linear-gradient(180deg, rgba(255,215,0,0.03) 0%, transparent 100%)' : 'transparent',
      }}
    >
      <div className="flex items-center gap-2 z-logo text-bolt-elements-textPrimary cursor-pointer">
        <div className="i-ph:sidebar-simple-duotone text-xl" />
        <a href="/" className="text-2xl font-semibold flex items-center group">
          <img
            src="/logo-light-styled.png"
            alt="logo"
            className="w-[90px] inline-block dark:hidden transition-all duration-300 group-hover:drop-shadow-[0_0_8px_rgba(255,215,0,0.5)]"
          />
          <img
            src="/logo-dark-styled.png"
            alt="logo"
            className="w-[90px] inline-block hidden dark:block transition-all duration-300 group-hover:drop-shadow-[0_0_8px_rgba(255,215,0,0.5)]"
          />
        </a>
      </div>
      {chat.started && (
        <>
          <span className="flex-1 px-4 truncate text-center text-bolt-elements-textPrimary">
            <ClientOnly>{() => <ChatDescription />}</ClientOnly>
          </span>
          <ClientOnly>
            {() => (
              <div className="mr-1">
                <HeaderActionButtons />
              </div>
            )}
          </ClientOnly>
        </>
      )}
      {!chat.started && <div className="flex-1" />}
      <ClientOnly>
        {() => (
          <div className="ml-2">
            <UserMenu />
          </div>
        )}
      </ClientOnly>
    </header>
  );
}
