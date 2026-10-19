-- Roles do not force MFA. Explicit Studio policy still protects the last factor,
-- and the independent usable-login-method guard prevents account lockout.
DROP TRIGGER keep_last_passkey;
DROP TRIGGER keep_last_totp;
CREATE TRIGGER keep_last_passkey_optional_mfa BEFORE DELETE ON auth_passkeys
WHEN EXISTS(SELECT 1 FROM account_security WHERE user_id = OLD.userId AND status = 'active' AND recovery_required = 0)
 AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = OLD.userId AND id <> OLD.id)
 AND (NOT EXISTS(SELECT 1 FROM auth_accounts WHERE userId = OLD.userId)
 OR (SELECT mfa_required FROM installation) = 1
 AND NOT EXISTS(SELECT 1 FROM auth_two_factors WHERE userId = OLD.userId AND verified = 1))
BEGIN SELECT RAISE(ABORT, 'LAST_FACTOR'); END;
CREATE TRIGGER keep_last_totp_optional_mfa BEFORE DELETE ON auth_two_factors
WHEN EXISTS(SELECT 1 FROM account_security WHERE user_id = OLD.userId AND status = 'active' AND recovery_required = 0)
 AND (SELECT mfa_required FROM installation) = 1
 AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = OLD.userId)
BEGIN SELECT RAISE(ABORT, 'LAST_FACTOR'); END;
