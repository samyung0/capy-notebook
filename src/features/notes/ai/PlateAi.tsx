import { AIChatPlugin, CopilotPlugin } from '@platejs/ai/react';
import { useCursorOverlay } from '@platejs/selection/react';
import {
  PlateElement,
  type PlateElementProps,
  PlateText,
  type PlateTextProps,
  useElement,
  usePluginOption,
} from 'platejs/react';
import { m } from '@/i18n';

/**
 * Renders the CursorOverlayPlugin snapshot taken when the editor blurs into an
 * element marked data-plate-focus (the AI prompt input). This is how the Plate
 * playground keeps the selection visible while the menu input has focus.
 */
export function AiCursorOverlay() {
  const { cursors } = useCursorOverlay();
  const streaming = usePluginOption(AIChatPlugin, 'streaming');
  if (streaming) return null;
  return (
    <>
      {cursors.map(({ id, selectionRects }) =>
        id === 'selection'
          ? selectionRects.map((rect, index) => (
              <div
                className="pointer-events-none absolute z-10 bg-action-accent/25"
                key={index}
                style={{
                  height: rect.height,
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                }}
              />
            ))
          : null
      )}
    </>
  );
}

export function AiLoadingBar() {
  const streaming = usePluginOption(AIChatPlugin, 'streaming');
  if (!streaming) return null;
  return (
    <div
      aria-label={m.editor_ai_writing()}
      className="h-0.5 w-full overflow-hidden bg-tint-accent-1"
      role="progressbar"
    >
      <div className="h-full w-1/3 animate-pulse bg-action-accent" />
    </div>
  );
}

export function AiLeaf(props: PlateTextProps) {
  return (
    <PlateText
      {...props}
      className="rounded-sm bg-tint-accent-1 text-tint-accent-1-fg underline decoration-action-accent/50"
    />
  );
}

export function AiAnchorElement(props: PlateElementProps) {
  return (
    <PlateElement {...props}>
      <span className="h-px" />
      {props.children}
    </PlateElement>
  );
}

export function GhostText() {
  const element = useElement();
  const isSuggested = usePluginOption(
    CopilotPlugin,
    'isSuggested',
    element.id as string
  );
  const suggestionText = usePluginOption(CopilotPlugin, 'suggestionText');
  if (!isSuggested || !suggestionText) return null;
  return (
    <span
      className="pointer-events-auto text-fg-muted/70 max-sm:hidden"
      contentEditable={false}
    >
      {suggestionText}
      {/* <span className="ml-2 inline-flex gap-1 align-middle text-[10px]">
        <button
          type="button"
          className="rounded-button border border-line bg-surface px-1.5 py-0.5 text-fg"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.getTransforms(CopilotPlugin).copilot.accept()}
        >
          Accept
        </button>
        <button
          type="button"
          className="rounded-button border border-line bg-surface px-1.5 py-0.5 text-fg-muted"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.getApi(CopilotPlugin).copilot.reject()}
        >
          Reject
        </button>
      </span> */}
    </span>
  );
}
