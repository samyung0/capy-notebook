import type { ReactNode } from 'react';
import { anonymousNoteAssetUrl } from '@/api/anonymous';
import type { AnonymousNote } from '@/api/types';
import { PublicActionMenu } from '@/components/app/PublicActionMenu';
import { PublicByline, PublicPage } from '@/components/app/PublicHeader';
import {
  type MaterialDocument,
  type MaterialValue,
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
import { TocSourceContext } from '@/features/materials/staticNodeComponents';
import { QuizPageHeader } from '@/features/quizzes/QuizPageHeader';
import { PublicEmbed } from './PublicEmbed';
import { PublicEmbedsContext } from './publicEmbeds';

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

type NoteProps = {
  mathMarkup: (tex: string, displayMode: boolean) => string;
  note: AnonymousNote;
  /** The whole note's blocks, for its table of contents. */
  toc: MaterialValue;
  token: string;
};

/** What a shared note's blocks render in, for the whole page and for each
 * streamed slice alike. */
function NoteContexts({
  children,
  mathMarkup,
  note,
  toc,
  token,
}: NoteProps & { children: ReactNode }) {
  return (
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
              <TocSourceContext.Provider value={toc}>
                {children}
              </TocSourceContext.Provider>
            </StaticMathContext.Provider>
          </EmbedViewContext.Provider>
        </PublicEmbedsContext.Provider>
      </AssetUrlContext.Provider>
    </PublicPageContext.Provider>
  );
}

/** The note's blocks, as `SharedNote` draws them. */
export function NoteBlocks({
  document,
  ...props
}: NoteProps & { document: MaterialDocument }) {
  return (
    <NoteContexts {...props}>
      {/* Blocks out of view skip style, layout and paint until scrolled
          near, so a long note's first paint and main thread do not pay for
          all of it. The clip margin keeps list markers, which draw outside
          their block; an equation is left out, as containment would stop
          its margins collapsing. Every box stays where it was. */}
      <MaterialPreview
        className="mx-0 min-h-0 px-0 pt-0 pb-8 sm:px-0 md:max-w-none [&>:not(.slate-equation)]:[contain-intrinsic-size:auto_2.5rem] [&>:not(.slate-equation)]:[content-visibility:auto] [&>:not(.slate-equation)]:[overflow-clip-margin:4rem]"
        content={document}
        isStandalone
        kind="note"
        title={props.note.name}
      />
    </NoteContexts>
  );
}

/** `/share/notes/{token}`, rendered only by the Worker: everyone gets the same
 * edge-cached HTML, and the browser hydrates just its islands (Island.tsx). */
export function SharedNote({
  document,
  ...props
}: NoteProps & { document: MaterialDocument }) {
  const { note } = props;
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
        <NoteBlocks document={document} {...props} />
        <MaterialAttributionFooter provenance={note.provenance} />
      </div>
    </PublicPage>
  );
}
