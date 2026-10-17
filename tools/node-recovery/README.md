# Full installation recovery on Node hosting

This maintainer tool backs up a stopped Open Whiteboard installation and restores it into an empty installation. It includes the private SQLite catalog, MySQL room data and image chunks, installation keys, accounts, MFA, sessions and settings. A board export does not contain all of these.

The tool is separate from the normal application package. It temporarily replaces the server while taking or restoring the backup. People cannot use the whiteboard during that maintenance window. Restore deliberately disconnects the saved hosting token and pauses automatic updates, so a restored copy cannot deploy into the original app. It also suppresses previously queued emails to prevent duplicate delivery; resend invitations or other messages if they are still needed.

## Supported installations

- Node 22, with the private SQLite catalog backend used by the GoDaddy wizard.
- Matching application schemas and database namespaces at source and destination. Initialize the destination using the same official package, but do not create its owner account.
- Installation-managed authentication and encryption keys. Externally supplied `AUTH_SECRET`, `AUTH_SECRETS` or `AUTH_ENCRYPTION_KEYS` require a separate recovery procedure and are refused here.
- An archive below 128 MiB encrypted and 256 MiB expanded. Larger installations need an offline database backup procedure; this in-memory tool fails without producing an incomplete backup.

## Maintainer procedure

Keep a private operation record outside the repository. Save the original release URL, checksum, app IDs and operation IDs before changing an app. Use a separate retry identifier for each provider write, and reuse it only for the identical request. Confirm provider completion as well as application health at each deployment.

1. Download and verify the official Node ZIP currently installed. Extract a separate copy and run `node tools/node-recovery/build.mjs /absolute/path/to/extracted-copy`. ZIP the contents of that directory. Keep the original release ZIP unchanged.
2. Generate a random 32-byte encryption key encoded as base64url and a separate random 32-byte bearer token encoded as hexadecimal. Store both outside the repository in private files. Add `WHITEBOARD_RECOVERY_KEY`, `WHITEBOARD_RECOVERY_TOKEN` and `WHITEBOARD_RECOVERY_MODE=backup` to the source app's **Publish** secrets. Preserve every existing setting. Import and publish the temporary package. Wait for the provider deployment to complete and `/healthz` to return `ready: true, maintenance: true`.
3. Send an authenticated `POST /recovery/backup` using `Authorization: Bearer <recovery token>`. Save the response as a private `.owbackup` file and record its SHA-256. The key is required to restore it; store a recovery copy of the key separately from the archive. Never put either credential in a URL, shell history or public log.
4. Republish the unchanged official ZIP on the source, even if taking the backup failed. Confirm normal health, sign-in and saved data. Remove only the three temporary recovery secrets. Keep the source installation and the encrypted backup until recovery has been verified.
5. Initialize an empty destination using the same official release, with its own app ID, origin and hosting database. Set the temporary recovery secrets there with the same encryption key and `WHITEBOARD_RECOVERY_MODE=restore`. Publish the temporary package. Send the encrypted archive as the body of an authenticated `POST /recovery/restore`.
6. Require `restored: true` before replacing the destination's maintenance package with the unchanged official ZIP. If the restore is interrupted, keep maintenance running and retry the **identical archive**. The saved digest prevents switching archives partway through. A populated destination is refused; use a new empty app instead of overwriting it.
7. Confirm normal health, owner sign-in and MFA, board contents, settings and uploaded image bytes. Remove the destination's temporary recovery secrets. Connect updates explicitly to the destination app only after these checks pass.

GoDaddy starts Preview during an import. Without the temporary Publish secrets, the maintenance server answers its supervisor's health probe but exposes no recovery endpoint and opens no database. An authenticated `GET /recovery/status` reports whether the configured operation is busy or complete. Recovery endpoints require the canonical host and reject a mismatched browser origin.

## Consistency and failure handling

The tool holds the same namespace-specific MySQL ownership lock as the application. It refuses to run alongside a normal application writer. It snapshots SQLite through `VACUUM INTO`, checks integrity, and reads MySQL in a consistent transaction. Only the application's known tables and installed schemas are accepted; SQL from an archive is never executed.

Restore writes an authenticated-archive digest marker before changing either store. MySQL is restored transactionally, then the validated SQLite catalog is installed by atomic rename. A retry after an interruption uses the same archive and completes both stores. A lost success response can be retried without reapplying the restore. A restored clone retains authentication keys but rebinds the private catalog location guard to its own directory.

The backup uses AES-256-GCM with a fresh nonce. Wrong keys, changed ciphertext, invalid archives and schema differences fail before data is restored. The HTTP server does not log credentials, database values or raw storage exceptions.

## Verification

Run `node --test tools/node-recovery/*.test.mjs` after installing repository dependencies. The HTTP tests cover authorization, host/origin checks and an unconfigured Preview.

`node tools/node-recovery/recovery.integration.mjs` requires a built Node package and a disposable local MySQL server. It only accepts `DB_HOST=127.0.0.1` and creates/drops the fixed databases `whiteboard_recovery_source_test` and `whiteboard_recovery_target_test`. The configured test user needs permissions on those two databases. It verifies full recovery using the real packaged app, live-writer exclusion, an interruption between stores, retry identity and refusal to overwrite a populated destination. The Node hosting CI job runs these checks.
