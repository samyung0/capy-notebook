import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import {
  YouTubeEmbed,
  youtubeEmbedUrl,
} from '@/features/materials/YouTubeEmbed';
import { m } from '@/i18n';
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
      setError(m.editor_youtube_invalid());
      return;
    }
    onSave(id);
  }

  return (
    <SimpleDialog
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            {m.action_cancel()}
          </Button>
          <Button disabled={!videoId} onClick={save}>
            {m.action_insert()}
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title={m.youtube_dialog_title()}
    >
      <div className="flex flex-col gap-3">
        <p className="text-fg-muted text-sm">{m.youtube_dialog_body()}</p>
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
