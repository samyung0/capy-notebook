import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useMemo } from 'react';
import { anonymousNoteAssetUrl, anonymousNoteQuery } from '@/api/anonymous';
import { isApiError } from '@/api/client';
import { PublicActionMenu } from '@/components/app/PublicActionMenu';
import { PublicByline, PublicPage } from '@/components/app/PublicHeader';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Skeleton } from '@/components/ui/feedback';
import {
  type MaterialDocument,
  parseMaterialDocument,
} from '@/features/materials/document';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { MaterialPreview } from '@/features/materials/MaterialPreview';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { QuizPageHeader } from '@/features/quizzes/QuizPage';
import { getLocale, m } from '@/i18n';

const plainText = (node: unknown): string =>
  typeof node === 'object' && node
    ? 'text' in node && typeof node.text === 'string'
      ? node.text
      : 'children' in node && Array.isArray(node.children)
        ? node.children.map(plainText).join('')
        : ''
    : '';

/** The page title already names the note, so a first heading that repeats it
 * is left out. */
function withoutRepeatedTitle(
  content: unknown,
  title: string
): MaterialDocument | null {
  const document = parseMaterialDocument(content);
  if (!document) return null;
  const [first, ...rest] = document.value;
  return first?.type === 'h1' && plainText(first).trim() === title.trim()
    ? { ...document, value: rest }
    : document;
}

/** `/share/notes/$noteId`: the param is the signed share token
 * `{id}.{signature}`. Everyone reads the same edge-cached projection through
 * the site Worker and renders it with the static renderer. */
export default function SharedNote() {
  const params = useParams({ strict: false });
  const token = (params as { noteId: string }).noteId;
  const {
    data: note,
    error,
    isError,
    isLoading,
  } = useQuery({ ...anonymousNoteQuery(token), retry: false });
  const document = useMemo(
    () => note && withoutRepeatedTitle(note.content, note.name),
    [note]
  );

  if (isLoading)
    return (
      <PublicPage>
        <Skeleton className="h-[60vh] w-full" />
      </PublicPage>
    );
  if (isError || !note || !document)
    return (
      <PublicPage>
        <WorkspaceError
          title={
            isApiError(error) && error.status === 404
              ? m.error_private_title()
              : m.note_unable_load()
          }
        />
      </PublicPage>
    );

  return (
    <PublicPage>
      <QuizPageHeader
        actions={<PublicActionMenu id={note.id} kind="note" />}
        byline={<PublicByline author={note.author} />}
        className="pt-2 sm:pt-2"
        meta={m.note_updated({
          date: new Intl.DateTimeFormat(getLocale(), {
            dateStyle: 'medium',
          }).format(new Date(note.updatedAt)),
        })}
        title={note.name}
        topBar={false}
        trail={[]}
      />
      <div className="px-4 pt-2 pb-8 sm:px-6 lg:px-10 xl:px-16">
        <AssetUrlContext.Provider
          value={(assetId) => anonymousNoteAssetUrl(token, assetId)}
        >
          <MaterialPreview
            className="mx-0 min-h-0 px-0 pt-0 pb-8 sm:px-0 md:max-w-none"
            content={document}
            isStandalone
            kind="note"
            title={note.name}
          />
        </AssetUrlContext.Provider>
        <MaterialAttributionFooter provenance={note.provenance} />
      </div>
    </PublicPage>
  );
}
