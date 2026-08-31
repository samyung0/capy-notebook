import {
  getVariableSuggestions,
  VariableExtension,
} from '@maily-to/core/extensions';
import type {
  FocusPosition,
  JSONContent,
  Editor as TiptapEditor,
} from '@tiptap/core';
import { Loader2Icon } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { cn } from '~/lib/classname';

const Editor = lazy(() =>
  import('@maily-to/core').then((module) => ({ default: module.Editor }))
);

interface EmailEditorProps {
  autofocus?: FocusPosition;
  content: JSONContent;
  onCreate: (editor: TiptapEditor) => void;
  onUpdate: (editor: TiptapEditor) => void;
  variables: ReadonlyArray<{ name: string }>;
}

export function EmailEditor({
  autofocus,
  content,
  onCreate,
  onUpdate,
  variables,
}: EmailEditorProps) {
  const [isLoading, setIsLoading] = useState(true);
  const extensions = useMemo(
    () => [
      VariableExtension.configure({
        suggestion: getVariableSuggestions('@'),
        variables: variables.map(({ name }) => ({
          label: name.replace(/([a-z])([A-Z])/g, '$1 $2'),
          name,
          required: true,
        })),
      }),
    ],
    [variables]
  );

  return (
    <>
      {isLoading && (
        <div className="flex w-full items-center justify-center py-10">
          <Loader2Icon className="h-8 w-8 animate-spin stroke-[2.5] text-gray-500" />
        </div>
      )}
      <Suspense>
        <Editor
          config={{
            autofocus,
            bodyClassName: '!mt-0 !border-0 !p-0',
            contentClassName:
              'editor-content mx-auto max-w-[calc(600px+80px)]! px-10! pb-10!',
            hasMenuBar: false,
            immediatelyRender: false,
            spellCheck: true,
            toolbarClassName: 'flex-wrap !items-start',
            wrapClassName: cn('editor-wrap', isLoading && 'hidden'),
          }}
          contentJson={content}
          extensions={extensions}
          onCreate={(editor) => {
            setIsLoading(false);
            onCreate(editor);
          }}
          onUpdate={onUpdate}
        />
      </Suspense>
    </>
  );
}
