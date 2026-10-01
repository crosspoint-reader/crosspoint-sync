-- Reading dates the user set by hand. Calendar dates stored like CrossInk's
-- (unix seconds at UTC midnight); they win over device-reported and derived dates.
ALTER TABLE documents ADD COLUMN start_date INTEGER;
ALTER TABLE documents ADD COLUMN finished_date INTEGER;
