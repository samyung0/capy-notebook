import { ExternalLink } from 'lucide-react';
import type { PlateElementProps } from 'platejs/react';
import { PlateElement } from 'platejs/react';
import { cn } from '@/lib/cn';

export interface YouTubeNode {
  children?: unknown[];
  provider?: string;
  type: string;
  videoId?: string;
}

export function youtubeEmbedUrl(videoId: string) {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?rel=0`;
}

export function YouTubeEmbed({
  videoId,
  editable = false,
}: {
  videoId: string;
  editable?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-black">
      <div className="aspect-video">
        <iframe
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          className="size-full"
          loading="lazy"
          src={youtubeEmbedUrl(videoId)}
          title="YouTube video"
        />
      </div>
      {editable && (
        <a
          className="flex items-center justify-end gap-1 px-3 py-1.5 text-fg-muted text-xs hover:text-fg"
          href={`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`}
          rel="noreferrer"
          target="_blank"
        >
          Open on YouTube
          <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}

export function YouTubeEmbedElement(props: PlateElementProps) {
  const element = props.element as unknown as YouTubeNode;
  const videoId =
    typeof element.videoId === 'string' ? element.videoId : undefined;

  return (
    <PlateElement
      {...props}
      className={cn(
        'my-3',
        !videoId && 'rounded-card border border-solid-error/30'
      )}
    >
      <div contentEditable={false}>
        {videoId ? (
          <YouTubeEmbed editable videoId={videoId} />
        ) : (
          <p className="p-3 text-sm text-solid-error">
            This YouTube embed is missing a video ID.
          </p>
        )}
      </div>
      {props.children}
    </PlateElement>
  );
}
