-- Comment threads are a flat list of comments that are only ever deleted: no
-- resolved state and no nested replies. Dropping parent_comment_id also drops
-- its self-reference check and material_comments_parent_idx.
ALTER TABLE material_discussions DROP COLUMN IF EXISTS is_resolved;
ALTER TABLE material_comments DROP COLUMN IF EXISTS parent_comment_id;
