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
import { useEditorPlugin, useEditorRef, usePluginOption } from 'platejs/react';
import { useMemo, useState } from 'react';
import { BlockToolbar } from '@/components/ui/BlockToolbar';
import { Input } from '@/components/ui/Input';
import { PopupMotion } from '@/components/ui/PopupMotion';
import { Separator } from '@/components/ui/Separator';
import { EditorIcon } from '@/features/notes/EditorIcon';
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

  const invalid = attemptedSubmit && !validateUrl(editor, url);
  const cancelEdit = () => {
    setAttemptedSubmit(false);
    api.floatingLink.show('edit', editor.id);
    editor.tf.focus(editor.selection ? { at: editor.selection } : undefined);
  };

  return (
    <PopupMotion
      open={state.isOpen}
      positionClassName="z-50"
      positionRef={ref}
      style={props.style}
    >
      {state.isEditing ? (
        <form
          className="z-50 flex w-80 flex-col rounded-lg border border-overlay-line bg-overlay p-1 text-fg shadow-pop"
          onSubmit={(event) => {
            event.preventDefault();
            setAttemptedSubmit(true);
            if (!validateUrl(editor, url)) return;
            submitFloatingLink(editor);
            setAttemptedSubmit(false);
          }}
        >
          <FloatingLinkUrlInput asChild>
            <Input
              aria-invalid={invalid}
              aria-label={m.editor_link_url()}
              className="h-7 py-1 font-medium text-sm"
              leftIcon="link"
              placeholder="https://example.com"
              variant="transparent"
              wrapperClassName={cn(
                'rounded-none px-2 focus-within:bg-surface-hover-bg/40 [&_svg]:size-4',
                invalid && 'ring-1 ring-solid-error'
              )}
            />
          </FloatingLinkUrlInput>
          <Separator className="my-1" />
          <Input
            aria-label={m.editor_link_text()}
            className="h-7 py-1 font-medium text-sm"
            leftIcon="alignLeft"
            onChange={(event) => setOption('text', event.target.value)}
            placeholder={m.editor_link_text_placeholder()}
            value={text}
            variant="transparent"
            wrapperClassName="rounded-none px-2 focus-within:bg-surface-hover-bg/40 [&_svg]:size-4"
          />
          <Separator className="my-1" />
          <div className="flex items-center justify-end gap-0">
            <FloatingActionButton label={m.editor_link_save()} type="submit">
              <EditorIcon name="check" />
            </FloatingActionButton>
            <FloatingActionButton
              label={m.editor_link_cancel()}
              onClick={cancelEdit}
            >
              <EditorIcon name="x" />
            </FloatingActionButton>
          </div>
          {invalid && (
            <p className="mt-1.5 text-solid-error text-xs" role="alert">
              {m.editor_link_invalid()}
            </p>
          )}
        </form>
      ) : (
        <BlockToolbar aria-label={m.editor_link_actions()}>
          <FloatingActionButton
            label={m.editor_link_edit()}
            {...editButtonProps}
          >
            <EditorIcon name="pencil" />
          </FloatingActionButton>
          <FloatingActionButton asChild label={m.editor_link_open()}>
            <LinkOpenButton rel="noopener noreferrer">
              <EditorIcon name="externalLink" />
            </LinkOpenButton>
          </FloatingActionButton>
          <FloatingActionButton
            label={m.editor_link_remove()}
            variant="danger-light"
            {...unlinkButtonProps}
          >
            <EditorIcon name="unlink" />
          </FloatingActionButton>
        </BlockToolbar>
      )}
    </PopupMotion>
  );
}
