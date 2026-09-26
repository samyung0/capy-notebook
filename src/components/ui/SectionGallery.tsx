import { type ReactNode, useCallback, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';

export interface GallerySection {
  content: ReactNode;
  /** Sidebar only, like the thumbnail. */
  count?: number;
  id: string;
  label: string;
  thumbnail?: ReactNode;
}

/** Section links beside one scrolling gallery; the link for the section in
 * view stays highlighted. The sidebar and divider hide below md, or always
 * when `nav` is false. Shared by
 * IconPicker and the Add file Create tab. */
export function SectionGallery({
  sections,
  label,
  initialSectionId,
  className,
  nav = true,
}: {
  sections: GallerySection[];
  label: string;
  /** Section scrolled to on mount. */
  initialSectionId?: string;
  className?: string;
  /** Hides the section sidebar and its divider at every width. */
  nav?: boolean;
}) {
  const galleryId = useId();
  const [activeId, setActiveId] = useState(initialSectionId ?? sections[0]?.id);
  const galleryRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);

  const syncActive = useCallback(() => {
    const gallery = galleryRef.current;
    if (!gallery) return;
    const top =
      gallery.scrollTop +
      Number.parseFloat(getComputedStyle(gallery).paddingTop);
    let index = 0;
    sectionRefs.current.forEach((section, i) => {
      if (section && section.offsetTop <= top + 1) index = i;
    });
    // The last section may be too short to reach the top of the gallery.
    if (
      gallery.scrollTop > 0 &&
      gallery.scrollTop + gallery.clientHeight >= gallery.scrollHeight - 1
    ) {
      index = sections.length - 1;
    }
    setActiveId(sections[index]?.id);
  }, [sections]);

  const scrollToSection = (index: number, behavior: ScrollBehavior) => {
    const gallery = galleryRef.current;
    const section = sectionRefs.current[index];
    if (!(gallery && section)) return;
    gallery.scrollTo({
      behavior,
      top:
        section.offsetTop -
        Number.parseFloat(getComputedStyle(gallery).paddingTop),
    });
  };

  // Reading the latest values through refs keeps the ref callback stable, so
  // React attaches the gallery once and the initial scroll runs only on mount.
  const syncActiveRef = useRef(syncActive);
  syncActiveRef.current = syncActive;
  const initialIndex = useRef(
    Math.max(
      0,
      sections.findIndex((section) => section.id === initialSectionId)
    )
  );
  const observeGallery = useCallback((node: HTMLDivElement | null) => {
    galleryRef.current = node;
    if (!node) return;
    const section = sectionRefs.current[initialIndex.current];
    if (section) {
      node.scrollTop =
        section.offsetTop -
        Number.parseFloat(getComputedStyle(node).paddingTop);
    }
    const observer = new ResizeObserver(() => syncActiveRef.current());
    observer.observe(node);
    return () => {
      observer.disconnect();
      galleryRef.current = null;
    };
  }, []);

  return (
    <div className={cn('flex min-h-0', className)}>
      {nav && (
        <nav
          aria-label={label}
          className="hidden w-[172px] shrink-0 overflow-y-auto pr-4 md:block"
        >
          <p className="t-label px-2 pt-1 pb-3 text-fg-muted">{label}</p>
          {sections.map((section, index) => (
            <Button
              aria-controls={`${galleryId}-${section.id}`}
              aria-current={activeId === section.id ? 'location' : undefined}
              className={cn(
                'mb-1 h-auto min-h-11.5 w-full justify-start gap-2 px-2 py-1.75 text-fg-muted',
                activeId === section.id &&
                  'bg-tint-accent-1/60 text-tint-accent-1-fg hover:bg-tint-accent-1'
              )}
              key={section.id}
              onClick={() =>
                scrollToSection(
                  index,
                  window.matchMedia('(prefers-reduced-motion: reduce)').matches
                    ? 'instant'
                    : 'smooth'
                )
              }
              size="sm"
              type="button"
              variant="ghost-hover"
            >
              {section.thumbnail}
              <span className="whitespace-normal text-left leading-tight">
                {section.label}
              </span>
              <span className="t-label ml-auto font-normal text-fg-muted">
                {section.count}
              </span>
            </Button>
          ))}
        </nav>
      )}
      <div
        aria-label={label}
        className={cn(
          'relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-0 pt-0! pb-3 outline-none focus-visible:ring-2 focus-visible:ring-tint-accent-1-fg',
          nav && 'sm:p-4.5 md:border-divider md:border-l md:p-6'
        )}
        onScroll={syncActive}
        ref={observeGallery}
        role="region"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus enables native keyboard scrolling of the gallery.
        tabIndex={0}
      >
        {sections.map((section, index) => (
          <section
            aria-labelledby={`${galleryId}-${section.id}-title`}
            className="pb-6 last:pb-0 min-[30rem]:pb-7"
            id={`${galleryId}-${section.id}`}
            key={section.id}
            ref={(node) => {
              sectionRefs.current[index] = node;
            }}
          >
            <h3
              className="t-subtitle mx-0.5 mb-3 min-[30rem]:mb-3.5"
              id={`${galleryId}-${section.id}-title`}
            >
              {section.label}
            </h3>
            {section.content}
          </section>
        ))}
      </div>
    </div>
  );
}
