ALTER TABLE pdf_annotations DROP CONSTRAINT pdf_annotations_kind_check;
ALTER TABLE pdf_annotations ADD CONSTRAINT pdf_annotations_kind_check CHECK (kind IN ('highlight','rectangle','ellipse','pen','text'));
ALTER TABLE pdf_annotations ADD COLUMN points jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(points) = 'array' AND jsonb_array_length(points) <= 4096);
ALTER TABLE pdf_annotations ADD COLUMN text text NOT NULL DEFAULT '' CHECK (char_length(text) <= 2000);
