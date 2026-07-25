export function canReplyAtDepth(depth: 0 | 1, canComment: boolean) {
  return depth === 0 && canComment;
}
