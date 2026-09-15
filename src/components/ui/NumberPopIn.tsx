/** Staggered digit entrance from transitions.dev/number-pop-in. */
export function NumberPopIn({ value }: { value: string }) {
  return (
    <span className="inline-flex tabular-nums">
      <span className="sr-only">{value}</span>
      <span aria-hidden key={value}>
        {Array.from(value, (digit, index) => (
          <span
            className="inline-block motion-safe:animate-[motion-number-pop_500ms_cubic-bezier(0.34,1.45,0.64,1)_both]"
            key={`${index}:${digit}`}
            style={{ animationDelay: `${index * 70}ms` }}
          >
            {digit}
          </span>
        ))}
      </span>
    </span>
  );
}
