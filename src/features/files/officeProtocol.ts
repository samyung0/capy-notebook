export const OFFICE_PROTOCOL_VERSION = 2 as const;

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';
export type OfficeMode = 'view' | 'edit';

export type OfficeAnalysis =
  | {
      format: 'docx';
      pageCount: number;
    }
  | {
      format: 'xlsx';
      sheetCount: number;
      sheetNames: string[];
      contentWidth: number;
      contentHeight: number;
    }
  | {
      format: 'pptx';
      slideCount: number;
      widthEmu: number;
      heightEmu: number;
      textCharacterCount: number;
    };

export type OfficeHostMessage =
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'load';
      format: OfficeFormat;
      fileName: string;
      bytes: ArrayBuffer;
      canEdit: boolean;
      mode: OfficeMode;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'set-capabilities';
      canEdit: boolean;
    };

export type OfficeRuntimeMessage =
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'ready';
      analysis: OfficeAnalysis;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'mode';
      mode: OfficeMode;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'dirty';
      dirty: boolean;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'save';
      bytes: ArrayBuffer;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'error';
      message: string;
      revision: number;
    };

export type OfficeRuntimePayload = {
  [Type in OfficeRuntimeMessage['type']]: Omit<
    Extract<OfficeRuntimeMessage, { type: Type }>,
    'version'
  >;
}[OfficeRuntimeMessage['type']];

export function isOfficeHostMessage(
  value: unknown
): value is OfficeHostMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown; version?: unknown };
  return (
    candidate.version === OFFICE_PROTOCOL_VERSION &&
    ((candidate.type === 'load' &&
      ['docx', 'pptx', 'xlsx'].includes(
        String((candidate as { format?: unknown }).format)
      ) &&
      ['edit', 'view'].includes(
        String((candidate as { mode?: unknown }).mode)
      ) &&
      typeof (candidate as { fileName?: unknown }).fileName === 'string' &&
      typeof (candidate as { canEdit?: unknown }).canEdit === 'boolean' &&
      (candidate as { bytes?: unknown }).bytes instanceof ArrayBuffer &&
      typeof (candidate as { revision?: unknown }).revision === 'number' &&
      isRevision((candidate as { revision: number }).revision)) ||
      (candidate.type === 'set-capabilities' &&
        typeof (candidate as { canEdit?: unknown }).canEdit === 'boolean'))
  );
}

export function isOfficeRuntimeMessage(
  value: unknown
): value is OfficeRuntimeMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    revision?: unknown;
    type?: unknown;
    version?: unknown;
  };
  return (
    candidate.version === OFFICE_PROTOCOL_VERSION &&
    typeof candidate.revision === 'number' &&
    isRevision(candidate.revision) &&
    ((candidate.type === 'ready' &&
      isOfficeAnalysis((candidate as { analysis?: unknown }).analysis)) ||
      (candidate.type === 'mode' &&
        ['edit', 'view'].includes(
          String((candidate as { mode?: unknown }).mode)
        )) ||
      (candidate.type === 'dirty' &&
        typeof (candidate as { dirty?: unknown }).dirty === 'boolean') ||
      (candidate.type === 'save' &&
        (candidate as { bytes?: unknown }).bytes instanceof ArrayBuffer) ||
      (candidate.type === 'error' &&
        typeof (candidate as { message?: unknown }).message === 'string'))
  );
}

function isRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isOfficeAnalysis(value: unknown): value is OfficeAnalysis {
  if (!value || typeof value !== 'object') return false;
  const analysis = value as Record<string, unknown>;
  if (analysis.format === 'docx') {
    return isCount(analysis.pageCount);
  }
  if (analysis.format === 'xlsx') {
    return (
      isCount(analysis.sheetCount) &&
      Array.isArray(analysis.sheetNames) &&
      analysis.sheetNames.every((name) => typeof name === 'string') &&
      isFiniteNumber(analysis.contentWidth) &&
      isFiniteNumber(analysis.contentHeight)
    );
  }
  if (analysis.format === 'pptx') {
    return (
      isCount(analysis.slideCount) &&
      isFiniteNumber(analysis.widthEmu) &&
      isFiniteNumber(analysis.heightEmu) &&
      isCount(analysis.textCharacterCount)
    );
  }
  return false;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
