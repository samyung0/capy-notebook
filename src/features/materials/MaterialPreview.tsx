import { MarkdownPlugin } from '@platejs/markdown';
import { createSlateEditor, createSlatePlugin } from 'platejs';
import {
  PlateStatic,
  type SlateElementProps,
  SlateLeaf,
  type SlateLeafProps,
} from 'platejs/static';
import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import {
  createMaterialDocument,
  type MaterialDocument,
  type MaterialValue,
  parseMaterialDocument,
} from './document';
import { staticNoteComponents } from './staticNodeComponents';
import { StaticMaterialKit } from './staticPlugins';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function suggestionOperations(node: Record<string, unknown>): string[] {
  const result: string[] = [];
  if (isRecord(node.suggestion) && typeof node.suggestion.type === 'string') {
    result.push(node.suggestion.type);
  }
  for (const [key, value] of Object.entries(node)) {
    if (
      key.startsWith('suggestion_') &&
      isRecord(value) &&
      typeof value.type === 'string'
    ) {
      result.push(value.type);
    }
  }
  return result;
}

function StaticSuggestionLeaf(props: SlateLeafProps) {
  const operations = suggestionOperations(
    props.leaf as Record<string, unknown>
  );
  const remove = operations.includes('remove');
  const update =
    operations.includes('update') || operations.includes('replace');
  return (
    <SlateLeaf
      {...props}
      as={remove ? 'del' : 'ins'}
      className={cn(
        'rounded-sm bg-tint-accent-2 text-solid-success no-underline',
        update && 'ring-1 ring-action-accent/45',
        remove &&
          'bg-tint-error text-solid-error line-through decoration-solid-error'
      )}
    >
      {props.children}
    </SlateLeaf>
  );
}

function StaticSuggestedBlock({
  props,
  operation,
}: {
  props: SlateElementProps;
  operation: string;
}) {
  const remove = operation === 'remove';
  const lineBreak = isRecord(
    (props.element as Record<string, unknown>).suggestion
  )
    ? (props.element as Record<string, any>).suggestion.isLineBreak === true
    : false;
  return (
    <div
      className={cn(
        'rounded-sm bg-tint-accent-2 text-solid-success',
        lineBreak && 'after:ml-1 after:content-["↵"]',
        remove &&
          'bg-tint-error text-solid-error line-through decoration-solid-error'
      )}
      data-static-block-suggestion={operation}
    >
      {props.children}
    </div>
  );
}

const StaticSuggestionPlugin = createSlatePlugin({
  key: 'suggestion',
  node: { isLeaf: true },
  render: {
    aboveNodes: ({ element }) => {
      const operations = suggestionOperations(
        element as Record<string, unknown>
      );
      if (!operations.length) return;
      const operation = operations.includes('remove')
        ? 'remove'
        : operations[0];
      return (props) => (
        <StaticSuggestedBlock
          operation={operation}
          props={props as unknown as SlateElementProps}
        />
      );
    },
    node: StaticSuggestionLeaf,
  },
});

/**
 * Universal read-only material renderer. Pending Plate suggestion metadata is
 * rendered directly from the shared material head; it is never hidden or
 * reconstructed from collaboration rows.
 */
export function MaterialPreview({
  content,
  className,
}: {
  content: string | MaterialDocument;
  className?: string;
}) {
  const editor = useMemo(
    () =>
      createSlateEditor({
        components: staticNoteComponents,
        plugins: [...StaticMaterialKit, StaticSuggestionPlugin],
      }),
    []
  );

  const value = useMemo<MaterialValue>(() => {
    const document = parseMaterialDocument(content);
    if (document) return document.value;
    try {
      if (typeof content !== 'string') return content.value;
      const imported = editor
        .getApi(MarkdownPlugin)
        .markdown.deserialize(content) as MaterialValue;
      return createMaterialDocument(imported).value;
    } catch (cause) {
      if (import.meta.env.DEV)
        console.error(
          'MaterialPreview: markdown deserialization failed',
          cause
        );
      return [
        {
          children: [{ text: typeof content === 'string' ? content : '' }],
          type: 'p',
        },
      ];
    }
  }, [content, editor]);

  return (
    <PlateStatic
      className={cn(
        'note-editor whitespace-break-spaces p-6 text-[0.95rem]',
        className
      )}
      editor={editor}
      value={value}
    />
  );
}
