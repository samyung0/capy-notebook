export interface YouTubeNode {
  children?: unknown[];
  provider?: string;
  type: string;
  videoId?: string;
  width?: string | number;
}

export function youtubeEmbedUrl(videoId: string) {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?rel=0`;
}

export function youtubeWatchUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

export function YouTubeEmbed({ videoId }: { videoId: string }) {
  return (
    <div className="aspect-video overflow-hidden rounded-lg border border-line bg-black">
      <iframe
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        className="size-full"
        loading="lazy"
        src={youtubeEmbedUrl(videoId)}
        title="YouTube"
      />
    </div>
  );
}
