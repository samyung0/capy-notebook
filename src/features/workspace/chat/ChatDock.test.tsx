import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { m } from '@/i18n';
import { ChatDock } from './ChatDock';
import type { VoiceInput } from './VoiceInput';

// No DOM here: the dock is rendered once per state of the composer's voice
// input (useVoiceInput, shared with the full composer) and read as markup.
function dock(voice: Partial<VoiceInput>, text = '') {
  return renderToStaticMarkup(
    <ChatDock
      fieldRef={createRef()}
      office={false}
      onOpenHistory={() => {}}
      onSend={() => {}}
      onTextChange={() => {}}
      overLimit={false}
      sendDisabled={!text}
      text={text}
      voice={{
        elapsedMs: 0,
        error: null,
        phase: 'idle',
        supported: true,
        toggle: () => {},
        ...voice,
      }}
    />
  );
}

/** The dock's field: the part the folded button grows into. */
function field(markup: string) {
  return markup.slice(markup.indexOf('data-chat-dock-field'));
}

/** The field's own attributes, where `inert` says it is folded away. */
function fieldTag(markup: string) {
  const at = markup.indexOf('data-chat-dock-field');
  return markup.slice(at, markup.indexOf('>', at));
}

describe('chat dock voice input', () => {
  it('puts the mic left of Send, and nowhere the browser cannot record', () => {
    const idle = field(dock({}));
    expect(idle).toContain(`aria-label="${m.voice_record()}"`);
    expect(idle.indexOf(m.voice_record())).toBeLessThan(
      idle.indexOf(m.chat_send())
    );
    expect(idle.indexOf(m.chat_placeholder())).toBeLessThan(
      idle.indexOf(m.voice_record())
    );
    expect(field(dock({ supported: false }))).not.toContain(m.voice_record());
  });

  it('stays open with the elapsed time while it records, and waits while it transcribes', () => {
    // A recording started on the chat page keeps the folded dock open here.
    const recording = dock({ elapsedMs: 42_500, phase: 'recording' });
    expect(recording).toContain('data-open="true"');
    expect(fieldTag(recording)).not.toContain('inert');
    expect(field(recording)).toContain(
      m.voice_elapsed({ elapsed: '0:42', limit: '2:00' })
    );
    expect(field(recording)).toContain(`aria-label="${m.voice_stop()}"`);

    const pending = field(dock({ phase: 'pending' }));
    expect(pending).toContain(`aria-label="${m.voice_transcribing()}"`);
    expect(pending).toContain('data-slot="spinner"');
    // A phone's dock folds into its button when idle with nothing typed.
    expect(dock({})).toContain('data-open="false"');
    expect(fieldTag(dock({}))).toContain('inert');
  });

  it('shows a failure inline inside the dock field', () => {
    const failed = field(dock({ error: m.voice_error_busy() }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(m.voice_error_busy());
    expect(failed.indexOf(m.voice_error_busy())).toBeLessThan(
      failed.indexOf(m.chat_placeholder())
    );
  });
});
