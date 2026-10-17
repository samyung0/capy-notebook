/**
 * Timing marks of an Office open (`capy:office:<stage>`), for UAT's measure
 * lane and later RUM: each realm (Capy's page, the runtime frame) marks its
 * own stages in its own performance timeline; a worker posts its times back
 * with its result and its frame marks them.
 */
const PREFIX = 'capy:office:';

type Detail = Record<string, boolean | number | string>;

export function officeMark(stage: string, detail?: Detail) {
  try {
    performance.mark(PREFIX + stage, detail && { detail });
  } catch {
    // A timeline that refuses a mark loses only the measurement.
  }
}

/** A stage another realm timed, at its epoch time (`epochNow` there). */
export function officeMarkAt(stage: string, epoch: number, detail?: Detail) {
  try {
    performance.mark(PREFIX + stage, {
      detail,
      startTime: epoch - performance.timeOrigin,
    });
  } catch {
    // An epoch before this realm started (or no timeline) is not marked.
  }
}

/** This realm's time as an epoch, comparable across realms. */
export function epochNow() {
  return performance.timeOrigin + performance.now();
}

/** A new open starts: the page's marks then belong to it alone. */
export function clearOfficeMarks() {
  try {
    for (const entry of performance.getEntriesByType('mark'))
      if (entry.name.startsWith(PREFIX)) performance.clearMarks(entry.name);
  } catch {
    // Nothing to clear without a timeline.
  }
}
