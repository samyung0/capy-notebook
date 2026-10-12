import { Link } from '@tanstack/react-router';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { m } from '@/i18n';
import '@/features/questions/trailMap/trailMap.css';
import './railMap/railMap.css';

/** One drawing's box: the map's ink and washes at sticker size. */
const ART = 'trail-map block h-auto w-[76px] overflow-visible sm:w-[104px]';

function Book() {
  return (
    <svg aria-hidden className={ART} viewBox="0 0 96 72">
      <path
        className="tm-card tm-ink"
        d="M10 22 Q29 16 48 23 L48 60 Q29 53 10 59 Z"
      />
      <path
        className="tm-card tm-ink"
        d="M48 23 Q67 16 86 22 L86 59 Q67 53 48 60 Z"
      />
      <path
        className="tm-ink-soft"
        d="M16 30 Q28 26 42 30 M16 37 Q28 33 42 37 M16 44 Q26 41 36 44 M54 30 Q66 26 80 30 M54 37 Q66 33 80 37"
      />
      <path className="tm-check" d="M58 44 L64 51 L80 33" />
      <path className="tm-ink-thin" d="M8 61 Q29 55 48 62 Q67 55 88 61" />
    </svg>
  );
}

function Quiz() {
  return (
    <svg aria-hidden className={ART} viewBox="0 0 96 72">
      <g transform="rotate(-5 40 38)">
        <path
          className="tm-card tm-ink"
          d="M20 8 L64 8.6 L63.4 66 L19.4 65.4 Z"
        />
        <path
          className="tm-ink-soft"
          d="M28 20 h6 v6 h-6 Z M38 23 h18 M28 34 h6 v6 h-6 Z M38 37 h16 M28 48 h6 v6 h-6 Z M38 51 h18"
        />
        <path
          className="tm-check"
          d="M29 22 l2 3 l4 -6 M29 36 l2 3 l4 -6"
          style={{ strokeWidth: 2 }}
        />
      </g>
      <g transform="rotate(38 70 40)">
        <path className="tm-hay tm-ink" d="M64 14 h10 v44 h-10 Z" />
        <path className="tm-roof tm-ink" d="M64 14 h10 v-6 h-10 Z" />
        <path className="tm-wood tm-ink" d="M64 58 L69 68 L74 58 Z" />
      </g>
    </svg>
  );
}

function Cards() {
  return (
    <svg aria-hidden className={ART} viewBox="0 0 96 72">
      <path
        className="tm-window tm-ink"
        d="M22 16 h44 v40 h-44 Z"
        transform="rotate(-12 48 40)"
      />
      <path
        className="tm-roof tm-ink"
        d="M26 16 h44 v40 h-44 Z"
        transform="rotate(-4 48 40)"
      />
      <g transform="rotate(6 48 40)">
        <path className="tm-card tm-ink" d="M30 16 h44 v40 h-44 Z" />
        <text className="tm-mark" textAnchor="middle" x={52} y={44}>
          ?
        </text>
      </g>
    </svg>
  );
}

/**
 * Learning's empty Progress, under the placeholder map: the three things that
 * record progress, drawn in the map's ink, then a link to start a workspace.
 */
export function RecordProgress() {
  const steps = [
    { Art: Book, label: m.learning_record_read() },
    { Art: Quiz, label: m.learning_record_quiz() },
    { Art: Cards, label: m.learning_record_cards() },
  ];
  return (
    <section className="mx-auto mt-7 flex w-full max-w-[640px] flex-col">
      <h3 className="mb-3.5 text-center font-bold text-fg-muted text-sm">
        {m.learning_record_title()}
      </h3>
      {/* rail-map gives the ticks and the question mark the railway's trail colour. */}
      <div className="rail-map grid grid-cols-3 gap-2 sm:gap-4">
        {steps.map(({ Art, label }) => (
          <div
            className="flex flex-col items-center gap-1.5 text-center"
            key={label}
          >
            <Art />
            <p className="font-semibold text-fg text-sm">{label}</p>
          </div>
        ))}
      </div>
      <UnderlineLink asChild className="mt-12 self-center">
        <Link preload="intent" to="/workspaces">
          {m.learning_create_workspace()}
        </Link>
      </UnderlineLink>
    </section>
  );
}
