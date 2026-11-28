/**
 * What Capy's film controls drive (FilmPlayer): a drawn film's ManimGX
 * player or a video film's <video>, the same to its viewer.
 */

/** A slide: one of the scene's sections, [start, end) seconds. */
export interface Chapter {
  end: number;
  start: number;
  title: string;
}

export interface FilmControl {
  readonly duration: number;
  pause(): void;
  /** Plays on; with `until` (a slide's end) a drawn film stops on that
   * slide's last frame. FilmPlayer stops a video film there itself. */
  play(until?: number): void;
  readonly playing: boolean;
  rate: number;
  /** Seconds; setting it seeks. */
  time: number;
}

/** A video film's <video> as a FilmControl. */
export function videoControl(video: HTMLVideoElement): FilmControl {
  return {
    get duration() {
      return Number.isFinite(video.duration) ? video.duration : 0;
    },
    pause: () => video.pause(),
    play: () => {
      if (video.ended) video.currentTime = 0;
      video.play().catch(() => undefined);
    },
    get playing() {
      return !(video.paused || video.ended);
    },
    get rate() {
      return video.playbackRate;
    },
    set rate(rate) {
      video.playbackRate = rate;
    },
    get time() {
      return video.currentTime;
    },
    set time(t) {
      video.currentTime = t;
    },
  };
}
