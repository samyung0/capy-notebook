export const OFFICE_PROTOCOL_VERSION = 3 as const;

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
      collaboration?: { epoch: number; initialUpdate: ArrayBuffer };
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'update';
      epoch: number;
      bytes: ArrayBuffer;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'flush';
      epoch: number;
      id: string;
    }
  | { version: typeof OFFICE_PROTOCOL_VERSION; type: 'export'; id: string }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'set-capabilities';
      canEdit: boolean;
    };

export type OfficeRuntimeMessage =
  | { version: typeof OFFICE_PROTOCOL_VERSION; type: 'initialized' }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'update' | 'collaboration-ready';
      epoch: number;
      bytes: ArrayBuffer;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'flushed';
      epoch: number;
      id: string;
      bytes: ArrayBuffer;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'checkpoint';
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'exported';
      id: string;
      bytes: ArrayBuffer;
      revision: number;
    }
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

type WithoutVersion<T> = T extends unknown ? Omit<T, 'version'> : never;
export type OfficeRuntimePayload = WithoutVersion<OfficeRuntimeMessage>;

export function isOfficeHostMessage(
  value: unknown
): value is OfficeHostMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== OFFICE_PROTOCOL_VERSION) return false;
  if (candidate.type === 'update')
    return isCount(candidate.epoch) && candidate.bytes instanceof ArrayBuffer;
  if (candidate.type === 'flush')
    return isCount(candidate.epoch) && typeof candidate.id === 'string';
  if (candidate.type === 'export') return typeof candidate.id === 'string';
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
      isRevision((candidate as { revision: number }).revision) &&
      (candidate.mode === 'view' ||
        isCollaboration(candidate.collaboration))) ||
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
  const raw = value as Record<string, unknown>;
  if (raw.version === OFFICE_PROTOCOL_VERSION && raw.type === 'initialized')
    return true;
  if (raw.version === OFFICE_PROTOCOL_VERSION && isCount(raw.revision)) {
    if (raw.type === 'checkpoint') return true;
    if (raw.type === 'exported')
      return typeof raw.id === 'string' && raw.bytes instanceof ArrayBuffer;
    if (
      raw.type === 'update' ||
      raw.type === 'collaboration-ready' ||
      raw.type === 'flushed'
    )
      return (
        isCount(raw.epoch) &&
        raw.bytes instanceof ArrayBuffer &&
        (raw.type !== 'flushed' || typeof raw.id === 'string')
      );
  }
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

function isCollaboration(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    isCount(candidate.epoch) && candidate.initialUpdate instanceof ArrayBuffer
  );
}
