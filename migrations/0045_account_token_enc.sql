-- Encrypted copy of the master (recovery) token so the app can show it again.
-- NULL when TOKEN_ENC_KEY is unset or the token predates this column.
ALTER TABLE accounts ADD COLUMN token_enc TEXT;
