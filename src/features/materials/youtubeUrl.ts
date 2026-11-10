/* YouTube URLs, apart from the React embed so plain page scripts can use them. */

export function youtubeEmbedUrl(videoId: string, autoplay = false) {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?rel=0${autoplay ? '&autoplay=1' : ''}`;
}

export function youtubeWatchUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/** What the player iframe may use. */
export const YOUTUBE_PLAYER_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';

/** A video id from a pasted link (watch, youtu.be, embed, shorts) or the id itself. */
export const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const WWW_PREFIX = /^www\./;

export function youtubeVideoId(input: string): string | null {
  const value = input.trim();
  if (YOUTUBE_ID.test(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(WWW_PREFIX, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/').find(Boolean) ?? null;
  } else if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'youtube-nocookie.com'
  ) {
    id =
      url.searchParams.get('v') ??
      (url.pathname.startsWith('/embed/')
        ? url.pathname.split('/')[2]
        : url.pathname.startsWith('/shorts/')
          ? url.pathname.split('/')[2]
          : null);
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}
