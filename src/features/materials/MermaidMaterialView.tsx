import { MERMAID_CAPTION_CLASS } from '@/features/notes/nodeStyles';
import type { MaterialDocument, MermaidElement } from './document';
import {
  MaterialRenderProvider,
  type MaterialRenderValue,
  StandaloneMaterialTitle,
} from './MaterialRenderContext';
import { MermaidView } from './staticViews';

/** View mode of a standalone mindmap or diagram, drawn straight from its
 * block without the static Plate renderer; it looks as that renderer did. */
export function MermaidMaterialView({
  content,
  material,
}: {
  content: MaterialDocument;
  material: MaterialRenderValue;
}) {
  const node = content.value.find(
    (child): child is MermaidElement => child.type === 'mermaid'
  );
  const caption =
    node?.children[0].children.map((leaf) => leaf.text).join('') ?? '';
  return (
    <MaterialRenderProvider value={material}>
      <div className="mx-auto w-full px-5 pt-4 pb-36 text-base sm:px-10 md:max-w-3xl">
        <StandaloneMaterialTitle kinds={['mindmap', 'diagram']} />
        {node && (
          <div className="my-3">
            <MermaidView
              caption={caption}
              source={node.source}
              theme={node.theme}
              title={material.title}
              width={node.width}
            />
            {caption.trim() && (
              <p className={MERMAID_CAPTION_CLASS}>{caption}</p>
            )}
          </div>
        )}
      </div>
    </MaterialRenderProvider>
  );
}
