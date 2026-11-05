-- Optional display name, shown on public pages instead of the username. Keeps case and spaces.
ALTER TABLE users ADD COLUMN display_name TEXT;
