-- A user's calibration for a matched audiobook (JSON { text, audio }): "this
-- reading position is this listening position". Percentages map through it in
-- both directions, so front matter that isn't narrated stops skewing jumps.
-- Kept when the same match is re-saved, cleared when it points elsewhere.
ALTER TABLE connector_matches ADD COLUMN anchor TEXT;
