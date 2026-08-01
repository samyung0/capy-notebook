import { insertEditorNode, type NoteEditorInstance } from './insertEditorNode';

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
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

export function insertYouTubeEmbed(
  editor: NoteEditorInstance,
  videoId: string
) {
  insertEditorNode(editor, {
    children: [{ text: '' }],
    provider: 'youtube',
    type: 'video',
    videoId,
  });
}
