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
