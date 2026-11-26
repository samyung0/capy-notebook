-- PDF marks round 1 (Epo 2026-11-24): marks are selected, moved and resized,
-- carry a comment, and the kinds add underline, a freehand marker, a note and
-- an arrow. A pen mark holds strokes drawn close together in time (strokes,
-- not points), and stroke kinds keep their width, a text box its size.
-- Coordinates change to page units with the unrotated page's longer side at
-- 1000 on both axes, so ink and text keep their shape. The marks saved before
-- (UAT only, drawn while the tools were hidden) used the old units and cannot
-- be converted without each page's size, so they go.
DELETE FROM pdf_annotations;
ALTER TABLE pdf_annotations DROP CONSTRAINT pdf_annotations_kind_check;
ALTER TABLE pdf_annotations ADD CONSTRAINT pdf_annotations_kind_check
  CHECK (kind IN ('highlight','underline','marker','pen','text','note','rectangle','ellipse','arrow'));
ALTER TABLE pdf_annotations DROP CONSTRAINT pdf_annotations_rects_check;
ALTER TABLE pdf_annotations ADD CONSTRAINT pdf_annotations_rects_check
  CHECK (jsonb_typeof(rects) = 'array' AND jsonb_array_length(rects) <= 1000);
ALTER TABLE pdf_annotations DROP COLUMN points;
ALTER TABLE pdf_annotations ADD COLUMN strokes jsonb NOT NULL
  CHECK (jsonb_typeof(strokes) = 'array' AND jsonb_array_length(strokes) <= 512);
ALTER TABLE pdf_annotations ADD COLUMN width double precision NOT NULL CHECK (width >= 0 AND width <= 80);
ALTER TABLE pdf_annotations ADD COLUMN size double precision NOT NULL CHECK (size >= 0 AND size <= 80);
ALTER TABLE pdf_annotations ADD COLUMN comment text NOT NULL CHECK (char_length(comment) <= 3000);
