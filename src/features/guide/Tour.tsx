import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pastReviewsQuery, useMaterials } from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/Popover';
import type { WorkspaceOpenSearch } from '@/features/materials/openItem';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { TOUR_SAMPLE_SESSION } from './tourSamples';
import { stopTour, tourPanels } from './tourStore';

type Found = Element | null | undefined;

type Step = {
  title: () => string;
  body: () => string;
  /** Opens the step's page; runs once when the step starts. */
  go?: () => void;
  /** The page it opens: the step waits for it, so the last page's parts are
   * not taken for its own. */
  at?: (pathname: string) => boolean;
  /** The data it opens is still loading: the step waits. */
  loading?: boolean;
  /** Its sample is not in the workspace: the step is passed over. */
  missing?: boolean;
  /** The page is open and cannot show the part at this width (a side panel
   * on a phone): the step is passed over at once. */
  absent?: () => boolean;
  /** Gets the page ready, every frame until it reports done. */
  prepare?: () => boolean;
  /** Opens what a room shows once it has loaded, every frame while the card
   * is up until it reports done; the card does not wait for it. */
  open?: () => boolean;
  /** The part lit; none puts the card in the middle. */
  spot?: () => Found;
  /** Without its part after the wait, the step still shows, centred. */
  optional?: boolean;
  /** Buttons outlined inside the lit part. */
  rings?: () => Found[];
  /** A label held open over a button, as its tooltip would be. */
  tip?: { target: () => Found; text: () => string };
};

type Box = { x: number; y: number; w: number; h: number };

const find = (selector: string) => document.querySelector(selector);
// The page panel of a page with the sidebar: Learning, Settings.
const pagePanel = () => find('main [data-slot="card"]');
const centrePanel = () => find('#viewer [data-slot="card"]');
const leftPanel = () =>
  find('[data-workspace-left-panel]')?.closest('[data-slot="card"]');
const questionDialog = () =>
  find('[role="dialog"] [data-undo-buttons]')?.closest('[role="dialog"]');

const box = (element: Element): Box => {
  const r = element.getBoundingClientRect();
  return { h: r.height, w: r.width, x: r.x, y: r.y };
};
const shown = (element: Found): element is Element =>
  !!element && element.getBoundingClientRect().width > 0;

// A target taller than this gets the card near its top, not its middle.
const TALL = 300;
// The card's width and its gap: the room a side needs to take the card.
const CARD_ROOM = 320 + 30;
// A target shorter than this, with no room beside, gets the card above or
// below it rather than on its corner, which would cover it.
const SMALL = 96;
// How long a step waits for its page and part before it is passed over.
const FIND_MS = 6000;

/**
 * The guided tour (human/miscellaneous.md 2026-10-26), mounted by the app
 * shell while one runs: each step opens its page, lights a part and outlines
 * the buttons it names, with the card beside the lit part or, without room,
 * in its bottom-right corner. Steps the page cannot show at this width (a side
 * panel on a phone) or whose sample is missing are passed over.
 */
export function Tour({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const router = useRouter();
  const { data: materials } = useMaterials(workspaceId, {
    errorBoundary: false,
  });
  const { data: reviews } = useInfiniteQuery({
    ...pastReviewsQuery({ workspaceIds: [workspaceId] }),
    meta: { errorBoundary: false },
  });
  const note = materials?.find((item) => item.type === 'note')?.id;
  const quiz = materials?.find((item) => item.type === 'quiz')?.id;
  const session = reviews?.pages[0]?.items[0]?.id;

  const inWorkspace = (search: WorkspaceOpenSearch = {}) =>
    navigate({
      params: { workspaceId },
      search,
      to: '/workspaces/$workspaceId',
    });
  // What a step already asked the page for (open the menu, click Edit), once
  // per step.
  const asked = useRef(new Set<string>());
  const once = (what: string) => {
    if (asked.current.has(what)) return false;
    asked.current.add(what);
    return true;
  };
  const inWorkspacePage = (path: string) =>
    path === `/workspaces/${workspaceId}`;
  const steps: Step[] = [
    {
      at: inWorkspacePage,
      body: m.tour_welcome_body,
      go: () => inWorkspace(),
      title: m.tour_welcome_title,
    },
    {
      absent: () => !!tourPanels() && !find('#rail'),
      at: inWorkspacePage,
      body: m.tour_files_body,
      prepare: () => {
        const panels = tourPanels();
        if (panels && once('files')) panels.showFiles();
        return !!panels;
      },
      spot: () => find('#rail [data-slot="card"]'),
      title: m.tour_files_title,
    },
    {
      absent: () => !!tourPanels() && !find('#files'),
      at: inWorkspacePage,
      body: m.tour_chats_body,
      // The left panel's view menu opens as a press on its title would.
      prepare: () => {
        const panels = tourPanels();
        if (!panels) return false;
        if (once('chats')) panels.showChats();
        const title = find('[data-workspace-left-panel] [data-panel-title]');
        if (!title) return false;
        if (once('menu'))
          title.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0 })
          );
        return title.getAttribute('data-state') === 'open';
      },
      spot: leftPanel,
      title: m.tour_chats_title,
    },
    {
      at: inWorkspacePage,
      body: m.tour_editor_body,
      go: () => inWorkspace({ material: note, mode: 'edit' }),
      loading: !materials,
      missing: !!materials && !note,
      // Back from the note's own quiz: its question dialog closes first.
      prepare: () => {
        const close = questionDialog()?.querySelector(
          '[data-slot="dialog-close"]'
        );
        if (close instanceof HTMLElement && once('close')) close.click();
        return !questionDialog();
      },
      // The room opens under the card; the cloud is outlined once it shows.
      rings: () => [find('#viewer [data-save-state]')],
      spot: centrePanel,
      title: m.tour_editor_title,
    },
    {
      at: inWorkspacePage,
      body: m.tour_quiz_body,
      // A quiz of its own, else the welcome note's embedded one: both edit a
      // question in the same dialog.
      go: () => inWorkspace({ material: quiz ?? note, mode: 'edit' }),
      loading: !materials,
      missing: !!materials && !quiz && !note,
      // The quiz loads under the card, lit in the centre panel, then its first
      // question opens for editing.
      open: () => {
        if (questionDialog()) return true;
        const edit = find('#viewer [data-question-edit]');
        if (edit instanceof HTMLElement && once('edit')) edit.click();
        return false;
      },
      rings: () => [
        find('[role="dialog"] [data-undo-buttons]'),
        find('[role="dialog"] [data-save-state]'),
      ],
      spot: () => questionDialog() ?? centrePanel(),
      tip: {
        target: () => find('[role="dialog"] [data-undo-buttons]'),
        text: m.tour_undo_redo,
      },
      title: m.tour_quiz_title,
    },
    {
      at: inWorkspacePage,
      body: m.tour_study_body,
      go: () => inWorkspace({ study: true }),
      spot: centrePanel,
      title: m.tour_study_title,
    },
    {
      at: (path) => path.startsWith('/learning/review/'),
      body: m.tour_review_body,
      go: () =>
        navigate({
          params: { workspaceId },
          to: '/learning/review/$workspaceId',
        }),
      spot: pagePanel,
      title: m.tour_review_title,
    },
    {
      at: (path) => path.startsWith('/learning/reviews/'),
      body: m.tour_result_body,
      // Without a past review, the page shows its sample.
      go: () =>
        navigate({
          params: { sessionId: session ?? TOUR_SAMPLE_SESSION },
          to: '/learning/reviews/$sessionId',
        }),
      loading: !reviews,
      spot: pagePanel,
      title: m.tour_result_title,
    },
    {
      at: (path) => path === '/settings',
      body: m.tour_settings_body,
      go: () =>
        navigate({ search: { tab: 'customizations' }, to: '/settings' }),
      // Brings the Chat rows into view.
      prepare: () => {
        const send = find(`[aria-label="${m.settings_chat_send_key()}"]`);
        send?.scrollIntoView({ block: 'center' });
        return !!send;
      },
      spot: pagePanel,
      title: m.tour_settings_title,
    },
    {
      at: (path) => path === '/',
      body: m.tour_done_body,
      go: () => navigate({ to: '/' }),
      optional: true,
      // The phone's mic scrolls with the page, whose scroller can still hold
      // the settings step's offset.
      prepare: () => {
        [...document.querySelectorAll('[data-voice-mic]')]
          .find(shown)
          ?.scrollIntoView({ block: 'nearest' });
        return true;
      },
      // The rail, the full sidebar and the phone top row each have a mic
      // that opens the account voice overlay; one shows.
      spot: () =>
        [...document.querySelectorAll('[data-voice-mic]')].find(shown),
      title: m.tour_done_title,
    },
  ];
  // The steps close over this render's data; the step loop reads the latest.
  const stepsRef = useRef(steps);
  useEffect(() => {
    stepsRef.current = steps;
  });

  const [wanted, setWanted] = useState({ by: 1, index: 0 });
  const [current, setCurrent] = useState<{ index: number } | null>(null);

  // Open the step's page, get it ready, then find its part; a step that never
  // shows its part is passed over in the direction the tour was going.
  useEffect(() => {
    asked.current.clear();
    const started = performance.now();
    let frame = 0;
    let went = false;
    let ready = false;
    const pass = () =>
      setWanted({ by: wanted.by, index: wanted.index + wanted.by });
    const look = () => {
      const step = stepsRef.current[wanted.index];
      if (step.missing) return pass();
      if (step.loading && performance.now() - started < FIND_MS) {
        frame = requestAnimationFrame(look);
        return;
      }
      if (!went) {
        went = true;
        step.go?.();
      }
      // The rendered route, not `location`: that flips as soon as navigation
      // starts, while a first visit's page still loads under the last one.
      const path = router.state.resolvedLocation?.pathname;
      const there = !step.at || (!!path && step.at(path));
      if (there && step.absent?.()) return pass();
      ready ||= there && (!step.prepare || step.prepare());
      const spot = ready ? step.spot?.() : null;
      if (ready && (!step.spot || shown(spot))) {
        setCurrent({ index: wanted.index });
        return;
      }
      if (performance.now() - started < FIND_MS) {
        frame = requestAnimationFrame(look);
        return;
      }
      if (step.optional) setCurrent({ index: wanted.index });
      else pass();
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [wanted]);

  // Pages move under the tour (panels slide, dialogs open, a new route
  // replaces the last one's panel), so the light, the outlines and the label
  // look their elements up every frame and re-render only when one changed.
  const [spotElement, setSpotElement] = useState<Element | null>(null);
  const [boxes, setBoxes] = useState<{
    spot: Box | null;
    rings: Box[];
    tip: Box | null;
  }>({ rings: [], spot: null, tip: null });
  useEffect(() => {
    if (!current) return;
    const step = stepsRef.current[current.index];
    let frame = 0;
    let seen = '';
    let lit: Element | null = null;
    let opened = !step.open;
    const follow = () => {
      if (!opened) opened = !!step.open?.();
      const found = step.spot?.();
      const element = shown(found) ? found : null;
      if (element !== lit) {
        lit = element;
        setSpotElement(element);
      }
      const next = {
        rings: (step.rings?.() ?? []).filter(shown).map(box),
        spot: element ? box(element) : null,
        tip: (() => {
          const target = step.tip?.target();
          return shown(target) ? box(target) : null;
        })(),
      };
      const key = JSON.stringify(next);
      if (key !== seen) {
        seen = key;
        setBoxes(next);
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [current]);

  const spot = boxes.spot;
  const beside =
    !!spot && Math.max(spot.x, innerWidth - spot.x - spot.w) >= CARD_ROOM;
  const small = !!spot && !beside && spot.h < SMALL;
  const anchorElement = beside || small ? spotElement : null;
  const anchor = useMemo(
    () => ({
      current: anchorElement ?? {
        // No room beside: the lit part's bottom-right corner; no part: a
        // little above the middle.
        getBoundingClientRect: () => {
          const element = spotElement;
          if (!shown(element))
            return new DOMRect(innerWidth / 2, innerHeight * 0.36, 0, 0);
          const r = element.getBoundingClientRect();
          return new DOMRect(r.right - 24, r.bottom - 24, 0, 0);
        },
      },
    }),
    [anchorElement, spotElement]
  );

  if (!current) return null;
  const index = current.index;
  const step = steps[index];
  const first = index === 0;
  const last = index === steps.length - 1;
  const go = (by: number) => setWanted({ by, index: index + by });
  // The next step's page is still opening.
  const moving = wanted.index !== index;
  // Beside: by the side with room, near the top of a tall part. In a corner:
  // the card's bottom-right on it. Small: under it, or over it in the lower
  // half. Centred: hanging from the point.
  const side =
    spot && beside
      ? spot.x + spot.w / 2 > innerWidth / 2
        ? 'left'
        : 'right'
      : small
        ? spot.y + spot.h / 2 < innerHeight / 2
          ? 'bottom'
          : 'top'
        : spot
          ? 'top'
          : 'bottom';
  const tall = !!spot && beside && spot.h > TALL;
  const align =
    beside || small ? (tall ? 'start' : 'center') : spot ? 'end' : 'center';
  const dialogLit = spotElement?.getAttribute('role') === 'dialog';
  const tip = boxes.tip;
  const tipBelow = !!tip && tip.y < innerHeight / 2;

  return createPortal(
    <>
      {/* Holds clicks while the tour runs; it dims the page itself only
          when no part is lit. */}
      <div
        className={cn(
          'fixed inset-0 z-40 transition-colors duration-(--motion-duration-medium)',
          !spot && 'bg-[rgb(17_17_27/0.45)]'
        )}
      />
      {spot && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[60] rounded-card-lg shadow-[0_0_0_2px_rgb(255_255_255/0.9),0_0_0_9999px_rgb(17_17_27/0.45)] transition-[top,left,width,height] duration-(--motion-duration-slow) ease-(--motion-ease-smooth-out)"
          style={{ height: spot.h, left: spot.x, top: spot.y, width: spot.w }}
        />
      )}
      {boxes.rings.map((ring) => (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[60] rounded-[9px] shadow-[0_0_0_2px_var(--color-solid-warning),0_0_0_6px_rgb(245_165_36/0.25)]"
          key={`${ring.x} ${ring.y}`}
          style={{
            height: ring.h + 6,
            left: ring.x - 3,
            top: ring.y - 3,
            width: ring.w + 6,
          }}
        />
      ))}
      {tip && step.tip && (
        <div
          className={cn(
            'pointer-events-none fixed z-[60] -translate-x-1/2 whitespace-nowrap rounded-md bg-tint-accent-dark/95 px-3 py-1.5 font-medium text-tint-accent-dark-fg text-xs',
            !tipBelow && '-translate-y-full'
          )}
          style={{
            left: tip.x + tip.w / 2,
            top: tipBelow ? tip.y + tip.h + 10 : tip.y - 10,
          }}
        >
          {step.tip.text()}
        </div>
      )}
      {/* A popover per step: opened after the step's own menu or dialog, it
          stays above it and takes clicks over its locked page; a dialog that
          opens under the card opens it again. */}
      <Popover key={`${index} ${dialogLit}`} open>
        <PopoverAnchor virtualRef={anchor} />
        <PopoverContent
          align={align}
          alignOffset={tall ? 56 : 0}
          aria-label={m.tour_label()}
          className="pointer-events-auto z-[60] w-80 gap-0 p-4"
          collisionPadding={16}
          onEscapeKeyDown={stopTour}
          onFocusOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          // The card takes focus, so Skip tour shows no focus ring.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus();
          }}
          side={side}
          sideOffset={beside ? 14 : 0}
        >
          <p className="text-fg-muted text-sm">
            {m.tour_counter({
              n: String(index + 1),
              total: String(steps.length),
            })}
          </p>
          <h2 className="mt-1 font-semibold text-[1.0625rem]">
            {step.title()}
          </h2>
          <p className="mt-1.5 text-fg-secondary text-sm leading-relaxed">
            {step.body()}
          </p>
          <div className="mt-4 flex items-center gap-2">
            {!last && (
              <Button
                className="-ml-4"
                onClick={stopTour}
                size="sm"
                variant="ghost-muted"
              >
                {m.tour_skip()}
              </Button>
            )}
            <span className="flex-1" />
            {!first && !last && (
              <Button
                disabled={moving}
                onClick={() => go(-1)}
                size="sm"
                variant="outline"
              >
                {m.tour_back()}
              </Button>
            )}
            <Button
              disabled={moving}
              onClick={last ? stopTour : () => go(1)}
              size="sm"
              variant="dark"
            >
              {first ? m.tour_start() : last ? m.tour_finish() : m.tour_next()}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </>,
    document.body
  );
}
