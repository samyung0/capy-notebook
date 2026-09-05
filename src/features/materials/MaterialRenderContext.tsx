import { createContext, useContext } from 'react';
import type { MaterialKind } from '@/api/types';
import { HEADING_CLASS } from '@/features/notes/nodeStyles';

export interface MaterialRenderValue {
  isStandalone: boolean;
  kind: MaterialKind;
  title: string;
}

const MaterialRenderContext = createContext<MaterialRenderValue | null>(null);

export function MaterialRenderProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: MaterialRenderValue | null;
}) {
  return (
    <MaterialRenderContext.Provider value={value}>
      {children}
    </MaterialRenderContext.Provider>
  );
}

export function StandaloneMaterialTitle({
  kinds,
}: {
  kinds: MaterialKind | MaterialKind[];
}) {
  const material = useContext(MaterialRenderContext);
  const accepted = Array.isArray(kinds) ? kinds : [kinds];
  if (
    !material?.isStandalone ||
    !accepted.includes(material.kind) ||
    !material.title.trim()
  )
    return null;
  return (
    <h1
      className={HEADING_CLASS.h1}
      contentEditable={false}
      data-testid="standalone-material-title"
    >
      {material.title}
    </h1>
  );
}
