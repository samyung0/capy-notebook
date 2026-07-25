import {
  createMaterialDocument,
  type MaterialValue,
} from '@/features/materials/document';

/** Snapshot helper used by tests and command payload diagnostics. */
export function editorValueDocument(value: MaterialValue) {
  return createMaterialDocument(value);
}
