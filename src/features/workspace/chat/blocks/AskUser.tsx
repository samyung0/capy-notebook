import { createContext, useContext } from 'react';
import { m } from '@/i18n';
import type { AskUserProps } from '../schema';

/** Whether the answer being rendered is the latest completed reply, whose
 * questions live in the docked question block instead of the bubble. */
export const LatestAnswerContext = createContext(false);

/** Inline rendering of a question. The latest reply shows nothing here (the
 * question block below the messages carries it); older replies keep the
 * question readable as history. */
export function AskUser({ props }: { props: AskUserProps }) {
  const latest = useContext(LatestAnswerContext);
  if (latest) return null;
  return (
    <p className="my-2 border-line border-l-2 pl-2 text-[12px] text-fg-muted">
      <span className="font-semibold text-fg-secondary">
        {m.chat_question_asked()}{' '}
      </span>
      {props.question}
    </p>
  );
}
