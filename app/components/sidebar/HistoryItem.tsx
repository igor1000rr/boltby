import { useParams } from '@remix-run/react';
import { classNames } from '~/utils/classNames';
import { type ChatHistoryItem } from '~/lib/persistence';
import WithTooltip from '~/components/ui/Tooltip';
import { useEditChatDescription } from '~/lib/hooks';
import { forwardRef, type ForwardedRef, useCallback } from 'react';
import { Checkbox } from '~/components/ui/Checkbox';

interface HistoryItemProps {
  item: ChatHistoryItem;
  onDelete?: (event: React.UIEvent) => void;
  onDuplicate?: (id: string) => void;
  exportChat: (id?: string) => void;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelection?: (id: string) => void;
}

export function HistoryItem({
  item,
  onDelete,
  onDuplicate,
  exportChat,
  selectionMode = false,
  isSelected = false,
  onToggleSelection,
}: HistoryItemProps) {
  const { id: urlId } = useParams();
  const isActiveChat = urlId === item.urlId;

  const { editing, handleChange, handleBlur, handleSubmit, handleKeyDown, currentDescription, toggleEditMode } =
    useEditChatDescription({
      initialDescription: item.description,
      customChatId: item.id,
      syncWithGlobalStore: isActiveChat,
    });

  const handleItemClick = useCallback(
    (e: React.MouseEvent) => {
      if (selectionMode) {
        e.preventDefault();
        e.stopPropagation();
        onToggleSelection?.(item.id);
      }
    },
    [selectionMode, item.id, onToggleSelection],
  );

  const handleCheckboxChange = useCallback(() => {
    onToggleSelection?.(item.id);
  }, [item.id, onToggleSelection]);

  const handleDeleteClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
      event.preventDefault();
      event.stopPropagation();

      if (onDelete) {
        onDelete(event as unknown as React.UIEvent);
      }
    },
    [onDelete, item.id],
  );

  return (
    <div
      className={classNames(
        'group rounded-lg text-sm text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-[rgba(255,215,0,0.04)] overflow-hidden flex justify-between items-center px-3 py-2 transition-all duration-200',
        { 'text-bolt-elements-textPrimary bg-[rgba(255,215,0,0.06)] border-l-2 border-[#FFD700]': isActiveChat },
        { 'cursor-pointer': selectionMode },
      )}
      onClick={selectionMode ? handleItemClick : undefined}
    >
      {selectionMode && (
        <div className="flex items-center mr-2" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            id={`select-${item.id}`}
            checked={isSelected}
            onCheckedChange={handleCheckboxChange}
            className="h-4 w-4"
          />
        </div>
      )}

      {editing ? (
        <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-2">
          <input
            type="text"
            className="flex-1 bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary rounded-md px-3 py-1.5 text-sm border border-bolt-elements-borderColor focus:outline-none focus:ring-1 focus:ring-[rgba(255,215,0,0.3)]"
            autoFocus
            value={currentDescription}
            onChange={handleChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
          />
          <button
            type="submit"
            className="i-ph:check h-4 w-4 text-bolt-elements-textTertiary hover:text-[#FFD700] transition-colors"
            onMouseDown={handleSubmit}
          />
        </form>
      ) : (
        <a
          href={`/chat/${item.urlId}`}
          className="flex w-full relative truncate block"
          onClick={selectionMode ? handleItemClick : undefined}
        >
          <WithTooltip tooltip={currentDescription}>
            <span className="truncate pr-24">{currentDescription}</span>
          </WithTooltip>
          <div
            className={classNames(
              'absolute right-0 top-0 bottom-0 flex items-center bg-transparent px-2 transition-colors',
            )}
          >
            <div className="flex items-center gap-2.5 text-bolt-elements-textTertiary opacity-0 group-hover:opacity-100 transition-opacity">
              <ChatActionButton
                toolTipContent="Export"
                icon="i-ph:download-simple h-4 w-4"
                onClick={(event) => {
                  event.preventDefault();
                  exportChat(item.id);
                }}
              />
              {onDuplicate && (
                <ChatActionButton
                  toolTipContent="Duplicate"
                  icon="i-ph:copy h-4 w-4"
                  onClick={(event) => {
                    event.preventDefault();
                    onDuplicate?.(item.id);
                  }}
                />
              )}
              <ChatActionButton
                toolTipContent="Rename"
                icon="i-ph:pencil-fill h-4 w-4"
                onClick={(event) => {
                  event.preventDefault();
                  toggleEditMode();
                }}
              />
              <ChatActionButton
                toolTipContent="Delete"
                icon="i-ph:trash h-4 w-4"
                className="hover:text-[#FF5252]"
                onClick={handleDeleteClick}
              />
            </div>
          </div>
        </a>
      )}
    </div>
  );
}

const ChatActionButton = forwardRef(
  (
    {
      toolTipContent,
      icon,
      className,
      onClick,
    }: {
      toolTipContent: string;
      icon: string;
      className?: string;
      onClick: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
      btnTitle?: string;
    },
    ref: ForwardedRef<HTMLButtonElement>,
  ) => {
    return (
      <WithTooltip tooltip={toolTipContent} position="bottom" sideOffset={4}>
        <button
          ref={ref}
          type="button"
          className={`text-bolt-elements-textTertiary hover:text-[#FFD700] transition-colors ${icon} ${className ? className : ''}`}
          onClick={onClick}
        />
      </WithTooltip>
    );
  },
);
