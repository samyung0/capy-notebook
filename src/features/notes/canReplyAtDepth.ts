export function canReplyAtDepth(depth: 0 | 1, canEdit: boolean) {
  return depth === 0 && canEdit;
}
