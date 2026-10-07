import { useState } from 'react';
import { m } from '@/i18n';
import { YOUTUBE_PLAYER_ALLOW, youtubeEmbedUrl } from './youtubeUrl';

export interface YouTubeNode {
  children?: unknown[];
  provider?: string;
  type: string;
  videoId?: string;
  width?: string | number;
}

const FRAME_CLASS =
  'aspect-video overflow-hidden rounded-lg border border-line bg-black';

/** The player iframe, started by a click on the poster. Server-rendered pages
 * build the same element in plain script (src/share/islands.ts). */
export function YouTubePlayer({ videoId }: { videoId: string }) {
  return (
    <iframe
      allow={YOUTUBE_PLAYER_ALLOW}
      allowFullScreen
      className="size-full"
      src={youtubeEmbedUrl(videoId, true)}
      title="YouTube"
    />
  );
}

/** The video's poster with a play button; the player (about 1 MB of YouTube
 * script) loads only once it is clicked. `data-youtube-play` lets
 * server-rendered pages start it without React. */
export function YouTubeEmbed({ videoId }: { videoId: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className={FRAME_CLASS}>
      {playing ? (
        <YouTubePlayer videoId={videoId} />
      ) : (
        <button
          aria-label={m.youtube_play()}
          className="group/play relative block size-full cursor-pointer"
          data-youtube-play={videoId}
          onClick={() => setPlaying(true)}
          type="button"
        >
          <img
            alt=""
            className="size-full object-cover"
            decoding="async"
            loading="lazy"
            src={`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`}
          />
          <svg
            aria-hidden
            className="absolute top-1/2 left-1/2 h-12 w-17 -translate-x-1/2 -translate-y-1/2 opacity-90 transition-opacity group-hover/play:opacity-100"
            viewBox="0 0 68 48"
          >
            <path
              className="fill-[#212121] group-hover/play:fill-[#f00]"
              d="M66.5 7.7c-.8-2.9-2.5-5.4-5.4-6.2C55.8.1 34 0 34 0S12.2.1 6.9 1.6c-3 .7-4.6 3.2-5.4 6.1C.1 13 0 24 0 24s.1 11 1.5 16.3c.8 2.9 2.5 5.4 5.4 6.2C12.2 47.9 34 48 34 48s21.8-.1 27.1-1.6c3-.7 4.6-3.2 5.4-6.1C67.9 35 68 24 68 24s-.1-11-1.5-16.3z"
            />
            <path className="fill-white" d="M45 24 27 14v20" />
          </svg>
        </button>
      )}
    </div>
  );
}
