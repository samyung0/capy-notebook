export const OFFICE_PROTOCOL_VERSION = 1 as const;

export type OfficeFormat = 'xlsx' | 'pptx';
export type OfficeMode = 'view' | 'edit';

export type OfficeAnalysis =
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
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'set-mode';
      mode: OfficeMode;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'save-committed';
      bytes: ArrayBuffer;
      revision: number;
    };

export type OfficeRuntimeMessage =
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'ready';
      analysis: OfficeAnalysis;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'mode';
      mode: OfficeMode;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'dirty';
      dirty: boolean;
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
    (candidate.type === 'load' ||
      candidate.type === 'set-mode' ||
      candidate.type === 'save-committed')
  );
}

export function isOfficeRuntimeMessage(
  value: unknown
): value is OfficeRuntimeMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown; version?: unknown };
  return (
    candidate.version === OFFICE_PROTOCOL_VERSION &&
    (candidate.type === 'ready' ||
      candidate.type === 'mode' ||
      candidate.type === 'dirty' ||
      candidate.type === 'save' ||
      candidate.type === 'error')
  );
}
