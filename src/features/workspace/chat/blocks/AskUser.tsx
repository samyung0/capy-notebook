import { createContext, useContext } from 'react';
import { m } from '@/i18n';

export interface AskUserProps {
  choices: string[];
  question: string;
}

/** Whether the answer being rendered is the latest completed reply, whose
 * questions live in the docked question block instead of the bubble. */
export const LatestAnswerContext = createContext(false);

/** Inline rendering of an answer's questions, as one group. The latest reply
 * shows nothing here (the question block below the messages carries them);
 * older replies keep them readable as history. */
export function AskUser({ questions }: { questions: AskUserProps[] }) {
  const latest = useContext(LatestAnswerContext);
  if (latest || !questions.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {questions.map((question, index) => (
        <p
          className="border-line border-l-2 pl-2 text-[13px] text-fg-muted"
          data-asked
          key={index}
        >
          <span className="font-semibold text-fg-secondary">
            {m.chat_question_asked()}{' '}
          </span>
          {question.question}
        </p>
      ))}
    </div>
  );
}
