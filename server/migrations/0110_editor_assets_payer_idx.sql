-- The Files page's Embeds tab lists every image and audio clip an account
-- pays for (M16): by payer, newest first, ready and not in the hidden trash
-- (ListEditorAssets).
CREATE INDEX editor_assets_payer_idx ON editor_assets (user_id, created_at DESC, id DESC)
  WHERE status = 'ready' AND trashed_at IS NULL;
