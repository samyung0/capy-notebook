import { ErrorId } from './ErrorId';

/** A form's error line: shown under the fields while the form stays open.
 * `errorId` is an unexpected failure's trace id (`unexpectedErrorId`). */
export function FormAlert({
  errorId,
  message,
}: {
  errorId?: string | null;
  message: string | null;
}) {
  if (!message) return null;
  return (
    <div
      className="mt-2 flex w-full flex-col gap-1 rounded-button bg-tint-error px-3 py-2 text-sm text-tint-error-fg"
      role="alert"
    >
      <p>{message}</p>
      {errorId && <ErrorId id={errorId} />}
    </div>
  );
}
