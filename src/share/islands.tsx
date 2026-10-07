import { type ComponentType, lazy, StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { anonymousNoteAssetUrl } from '@/api/anonymous';
import { USE_MSW } from '@/api/auth';
import { AppToaster } from '@/components/app/AppToaster';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { EmbedViewContext } from '@/features/materials/embeds/EmbedView';
import type { IslandName } from '@/features/materials/Island';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import {
  EmbedSlot,
  HtmlEmbedView,
  MermaidView,
  StaticMediaAsset,
} from '@/features/materials/staticViews';
import { PublicEmbedsContext } from './PublicEmbed';
import type { ShareState } from './state';

/* A server-rendered note's islands (features/materials/Island.tsx), hydrated
   from the props the server wrote beside them. Only this file and what the
   present islands need load; a note without islands loads none of it. */

const PublicEmbed = lazy(() =>
  import('./PublicEmbed').then((mod) => ({ default: mod.PublicEmbed }))
);

const VIEWS = {
  embed: EmbedSlot,
  html: HtmlEmbedView,
  media: StaticMediaAsset,
  mermaid: MermaidView,
} satisfies Record<IslandName, unknown>;

export async function hydrateIslands(
  state: Extract<ShareState, { kind: 'notes' }>,
  islands: HTMLElement[]
) {
  if (USE_MSW) {
    const { startMockServer } = await import('@/mocks/browser');
    await startMockServer();
  }
  const embeds = {
    embeds: new Map(state.embeds.map((embed) => [embed.id, embed])),
    token: state.token,
  };
  for (const island of islands) {
    // Each island's props are the ones the server wrote for that view.
    const View = VIEWS[
      island.dataset.island as IslandName
    ] as ComponentType<object>;
    hydrateRoot(
      island,
      <StrictMode>
        <TooltipProvider>
          <AssetUrlContext.Provider
            value={(assetId) => anonymousNoteAssetUrl(state.token, assetId)}
          >
            <PublicEmbedsContext.Provider value={embeds}>
              <EmbedViewContext.Provider value={PublicEmbed}>
                <View {...JSON.parse(island.dataset.islandProps ?? '{}')} />
              </EmbedViewContext.Provider>
            </PublicEmbedsContext.Provider>
          </AssetUrlContext.Provider>
        </TooltipProvider>
      </StrictMode>
    );
  }
  // Grading failures in embedded quizzes toast.
  const toaster = document.body.appendChild(document.createElement('div'));
  createRoot(toaster).render(<AppToaster />);
}
