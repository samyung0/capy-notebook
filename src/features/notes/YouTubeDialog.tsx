import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import {
  YouTubeEmbed,
  youtubeEmbedUrl,
} from '@/features/materials/YouTubeEmbed';
import { youtubeVideoId } from './youtube';

export function YouTubeDialog({
  initialUrl,
  onClose,
  onSave,
  open,
}: {
  initialUrl?: string;
  onClose: () => void;
  onSave: (videoId: string) => void;
  open: boolean;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const videoId = youtubeVideoId(url);

  useEffect(() => {
    if (!open) return;
    setUrl(initialUrl ?? '');
    setError('');
  }, [initialUrl, open]);

  function save() {
    const id = youtubeVideoId(url);
    if (!id) {
      setError('Paste a valid YouTube video URL.');
      return;
    }
    onSave(id);
  }

  return (
    <SimpleDialog
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={!videoId} onClick={save}>
            Insert
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title="YouTube embed"
    >
      <div className="flex flex-col gap-3">
        <p className="text-fg-muted text-sm">
          Embed a YouTube video without uploading a video file or using
          workspace storage.
        </p>
        <Input
          autoFocus
          onChange={(event) => {
            setUrl(event.target.value);
            setError('');
          }}
          placeholder="https://www.youtube.com/watch?v=..."
          value={url}
        />
        {error && <p className="text-sm text-solid-error">{error}</p>}
        {videoId && (
          <div className="overflow-hidden rounded-card">
            <YouTubeEmbed videoId={videoId} />
          </div>
        )}
        {videoId && (
          <p className="truncate text-fg-muted text-xs">
            {youtubeEmbedUrl(videoId)}
          </p>
        )}
      </div>
    </SimpleDialog>
  );
}
