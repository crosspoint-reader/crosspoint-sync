-- Server-wide key/value settings. Holds the generated session-signing key so web
-- sign-ins survive restarts and updates when SESSION_SECRET isn't set.
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
