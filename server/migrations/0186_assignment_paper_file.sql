-- A graded quiz made from a file (Epo 2026-11-20): its question paper is its one
-- assignment_files row, read live, and members answer it by upload only. Its
-- frozen copy is one open part worth the quiz's marks, marked by hand.
ALTER TABLE assignments ADD COLUMN paper_file boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT assignments_paper_file CHECK (NOT paper_file OR (kind = 'marked' AND upload_only AND marking = 'manual'));
