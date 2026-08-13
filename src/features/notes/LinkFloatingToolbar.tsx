import {
  flip,
  offset,
  type UseVirtualFloatingOptions,
} from '@platejs/floating';
import { validateUrl } from '@platejs/link';
import {
  FloatingLinkUrlInput,
  LinkOpenButton,
  LinkPlugin,
  submitFloatingLink,
  useFloatingLinkEdit,
  useFloatingLinkEditState,
} from '@platejs/link/react';
import { Check, ExternalLink, Pencil, Unlink, X } from 'lucide-react';
import { useEditorPlugin, useEditorRef, usePluginOption } from 'platejs/react';
import { useMemo, useState } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { FloatingActionButton } from './nodeComponents';

export function LinkFloatingToolbar() {
  const editor = useEditorRef();
  const { api, setOption } = useEditorPlugin(LinkPlugin);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const url = String(usePluginOption(LinkPlugin, 'url') ?? '');
  const text = String(usePluginOption(LinkPlugin, 'text') ?? '');
  const floatingOptions = useMemo<UseVirtualFloatingOptions>(
    () => ({
      middleware: [
        offset(8),
        flip({
          fallbackPlacements: ['bottom-end', 'top-start', 'top-end'],
          padding: 12,
        }),
      ],
      placement: 'bottom-start',
    }),
    []
  );
  const state = useFloatingLinkEditState({ floatingOptions });
  const { editButtonProps, props, ref, unlinkButtonProps } =
    useFloatingLinkEdit(state);

  if (!state.isOpen) return null;

  const invalid = attemptedSubmit && !validateUrl(editor, url);
  const cancelEdit = () => {
    setAttemptedSubmit(false);
    api.floatingLink.show('edit', editor.id);
    editor.tf.focus(editor.selection ? { at: editor.selection } : undefined);
  };

  if (state.isEditing) {
    return (
      <form
        className="z-50 flex w-80 flex-col gap-2 rounded-card border border-line bg-surface p-2 shadow-pop"
        onSubmit={(event) => {
          event.preventDefault();
          setAttemptedSubmit(true);
          if (!validateUrl(editor, url)) return;
          submitFloatingLink(editor);
          setAttemptedSubmit(false);
        }}
        ref={ref}
        style={props.style}
      >
        <label className="flex flex-col gap-1">
          <span className="font-medium text-fg-muted text-xs">
            {m.editor_link_url()}
          </span>
          <FloatingLinkUrlInput
            aria-invalid={invalid}
            aria-label={m.editor_link_url()}
            className={cn(
              'h-8 min-w-0 flex-1 rounded-input border border-line bg-surface px-2 text-sm outline-none',
              'focus:border-line-strong focus:ring-2 focus:ring-focus',
              invalid && 'border-solid-error'
            )}
            placeholder="https://example.com"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium text-fg-muted text-xs">
            {m.editor_link_text()}
          </span>
          <input
            aria-label={m.editor_link_text()}
            className="h-8 min-w-0 rounded-input border border-line bg-surface px-2 text-sm outline-none focus:border-line-strong focus:ring-2 focus:ring-focus"
            onChange={(event) => setOption('text', event.target.value)}
            placeholder={m.editor_link_text_placeholder()}
            value={text}
          />
        </label>
        <div className="flex items-center justify-end gap-0.5">
          <FloatingActionButton label={m.editor_link_save()} type="submit">
            <Check />
          </FloatingActionButton>
          <FloatingActionButton
            label={m.editor_link_cancel()}
            onClick={cancelEdit}
          >
            <X />
          </FloatingActionButton>
        </div>
        {invalid && (
          <p className="mt-1.5 text-solid-error text-xs" role="alert">
            {m.editor_link_invalid()}
          </p>
        )}
      </form>
    );
  }

  return (
    <div
      aria-label={m.editor_link_actions()}
      className="z-50 flex w-auto min-w-14 max-w-[90vw] items-center justify-center gap-0.5 overflow-x-auto rounded-card border border-line bg-surface p-1 shadow-pop"
      ref={ref}
      role="toolbar"
      style={props.style}
    >
      <FloatingActionButton label={m.editor_link_edit()} {...editButtonProps}>
        <Pencil />
      </FloatingActionButton>
      <FloatingActionButton asChild label={m.editor_link_open()}>
        <LinkOpenButton rel="noopener noreferrer">
          <ExternalLink />
        </LinkOpenButton>
      </FloatingActionButton>
      <FloatingActionButton
        label={m.editor_link_remove()}
        {...unlinkButtonProps}
      >
        <Unlink />
      </FloatingActionButton>
    </div>
  );
}
