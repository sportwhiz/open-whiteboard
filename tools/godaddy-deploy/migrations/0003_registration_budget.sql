ALTER TABLE installer_attempts ADD COLUMN credential_key TEXT;
CREATE INDEX installer_attempts_credential_key ON installer_attempts (credential_key);
