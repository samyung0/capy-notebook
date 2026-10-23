-- The Files tab lists the images and audio an account pays for in notes it
-- can no longer open (M16): by payer, newest first, ready and not in the
-- hidden trash (ListLostEditorAssets).
CREATE INDEX editor_assets_payer_idx ON editor_assets (user_id, created_at DESC, id DESC)
  WHERE status = 'ready' AND trashed_at IS NULL;
