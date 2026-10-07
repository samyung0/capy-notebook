import { anonymousNoteAssetUrl } from '@/api/anonymous';
import type { AnonymousNote } from '@/api/types';
import { PublicActionMenu } from '@/components/app/PublicActionMenu';
import { PublicByline, PublicPage } from '@/components/app/PublicHeader';
import {
  type MaterialDocument,
  parseMaterialDocument,
} from '@/features/materials/document';
import { EmbedViewContext } from '@/features/materials/embeds/EmbedView';
import {
  PublicPageContext,
  StaticMathContext,
} from '@/features/materials/Island';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { MaterialPreview } from '@/features/materials/MaterialPreview';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { QuizPageHeader } from '@/features/quizzes/QuizPage';
import { PublicEmbed, PublicEmbedsContext } from './PublicEmbed';

/** A node's text, as search snippets and the repeated-title check read it. */
export const plainText = (node: unknown): string =>
  typeof node === 'object' && node
    ? 'text' in node && typeof node.text === 'string'
      ? node.text
      : 'children' in node && Array.isArray(node.children)
        ? node.children.map(plainText).join('')
        : ''
    : '';

/** The page title already names the note, so a first heading that repeats it
 * is left out. */
export function withoutRepeatedTitle(
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

/** `/share/notes/{token}`, rendered only by the Worker: everyone gets the same
 * edge-cached HTML, and the browser hydrates just its islands (Island.tsx). */
export function SharedNote({
  document,
  mathMarkup,
  note,
  token,
}: {
  document: MaterialDocument;
  mathMarkup: (tex: string, displayMode: boolean) => string;
  note: AnonymousNote;
  token: string;
}) {
  return (
    <PublicPage>
      <QuizPageHeader
        actions={<PublicActionMenu id={note.id} kind="note" />}
        byline={
          <PublicByline author={note.author} updatedAt={note.updatedAt} />
        }
        className="pt-2 sm:pt-2"
        title={note.name}
        trail={[]}
      />
      <div className="px-4 pt-2 pb-8 sm:px-6 lg:px-10 xl:px-16">
        <PublicPageContext.Provider value>
          <AssetUrlContext.Provider
            value={(assetId) => anonymousNoteAssetUrl(token, assetId)}
          >
            <PublicEmbedsContext.Provider
              value={{
                embeds: new Map(note.embeds.map((embed) => [embed.id, embed])),
                token,
              }}
            >
              <EmbedViewContext.Provider value={PublicEmbed}>
                <StaticMathContext.Provider value={mathMarkup}>
                  <MaterialPreview
                    className="mx-0 min-h-0 px-0 pt-0 pb-8 sm:px-0 md:max-w-none"
                    content={document}
                    isStandalone
                    kind="note"
                    title={note.name}
                  />
                </StaticMathContext.Provider>
              </EmbedViewContext.Provider>
            </PublicEmbedsContext.Provider>
          </AssetUrlContext.Provider>
        </PublicPageContext.Provider>
        <MaterialAttributionFooter provenance={note.provenance} />
      </div>
    </PublicPage>
  );
}
