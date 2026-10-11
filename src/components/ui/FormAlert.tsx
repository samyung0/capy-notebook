/** A form's error line: shown under the fields while the form stays open. */
export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      className="mt-2 w-full rounded-button bg-tint-error px-3 py-2 text-sm text-tint-error-fg"
      role="alert"
    >
      {message}
    </p>
  );
}
