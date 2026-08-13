import { updateMaterialBodyTitleMax } from '@/api/gen/validators';
import type { GenerateKind } from '@/api/types';
import { m } from '@/i18n';

export const GENERATE_TITLE_MAX = updateMaterialBodyTitleMax;

export function defaultGenerateTitle(
  kind: GenerateKind,
  workspaceName: string,
  n: number
): string {
  const workspace = workspaceName.trim() || m.common_material();
  switch (kind) {
    case 'diagram':
      return m.generate_default_diagram_name({ n, workspace });
    case 'flashcards':
      return m.generate_default_flashcards_name({ n, workspace });
    case 'mindmap':
      return m.generate_default_mindmap_name({ n, workspace });
    case 'quiz':
      return m.generate_default_quiz_name({ n, workspace });
  }
}

export function nextGenerateTitle(
  kind: GenerateKind,
  workspaceName: string,
  existingTitles: readonly string[]
): string {
  const taken = new Set(
    existingTitles.map((title) => title.trim().toLowerCase()).filter(Boolean)
  );
  for (let n = 1; n < 10_000; n++) {
    const candidate = defaultGenerateTitle(kind, workspaceName, n);
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return defaultGenerateTitle(kind, workspaceName, Date.now());
}

export function validateGenerateTitle(
  title: string,
  existingTitles: readonly string[]
): string | null {
  const trimmed = title.trim();
  if (!trimmed) {
    return m.generate_name_required();
  }
  if (trimmed.length > GENERATE_TITLE_MAX) {
    return m.generate_name_too_long({ max: GENERATE_TITLE_MAX });
  }
  const key = trimmed.toLowerCase();
  if (
    existingTitles.some((existing) => existing.trim().toLowerCase() === key)
  ) {
    return m.generate_name_taken();
  }
  return null;
}
