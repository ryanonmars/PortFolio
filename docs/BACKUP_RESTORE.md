# Complete browser backups and restoration

**Settings** opens in the main application area while the board browser remains available. Its sections are **General**, **Backup & Restore**, **API Tokens**, and **About**. General shows the signed-in account. API Tokens retains the scoped token controls. About reports the actual application version, SQLite migration version, and Node runtime from the server.

## Browser workflow

Open **Settings → Backup & Restore → Download Backup**. PortFolio prepares a complete snapshot on the server, then streams its ZIP through an authenticated, short-lived download. Save it outside the server and keep a second copy on another storage device. An interrupted download is not a backup: download again and retain only complete files. Restoration performs an independent integrity check.

To restore a complete backup:

1. Select its ZIP under **Restore backup** and wait for upload and verification.
2. Review its creation date, originating application/database versions, verified board count, retained attachment count, and total attachment bytes. Attachment bytes include originals and generated previews.
3. Type **RESTORE** and confirm only when ready to replace the installation's current persistent state.
4. Wait for activation to finish. PortFolio enters maintenance, creates and validates a recovery backup, closes SQLite while switching files, and reopens the restored database. Large installations can take longer while recovery is verified; the page displays status.
5. Sign in again using an account/password from the backup. All browser sessions are invalidated. Normal activation requires no process or Docker restart.

Restore previews expire after 15 minutes. Cancel an expired preview and upload the file again. An unconfirmed restore returns to file selection with an error so you can retry.

Board JSON import/export remains separate: JSON imports one board and omits attachment binaries. Complete ZIP restore replaces the persistent installation state.

## Contents and compatibility

The portable ZIP format is `portfolio-complete-backup`, format version 1. `manifest.json` records the actual application version, UTC creation timestamp, database migration version/history/checksums, included components, and the exact path, byte length and SHA-256 of every enclosed file.

Files include `snapshot.sqlite` and `snapshot.sqlite.attachments/manifest.json` plus `objects/<attachment UUID>/original`, `thumbnail.webp` and `preview.webp` when present. The database contains boards, groups, device/network documentation, ports, cables, annotations, account records, settings/metadata, attachment metadata and API token digests. Retained soft-deleted/orphaned attachments are included so the existing recovery window remains recoverable. Counts refer to retained attachment records; the size shown includes originals and generated previews.

Raw API token strings are never stored by PortFolio. Password hashes, token digests, account records and all private documentation remain sensitive. ZIP files are not encrypted. Do not publish them or store them in public web directories. Runtime environment variables, `.env`, logs, caches, SQLite WAL/SHM sidecars, temporary uploads, previous backups and recovery archives are not recursively included. Deployment host/origin settings stay with the current installation; reconfigure those separately when moving servers.

Creation uses SQLite's supported online backup API, including committed WAL data. Existing attachment backup leases protect retained objects from garbage collection during copying; originals are immutable and upload publication is coordinated with metadata transactions. Uploaded archives must match their manifest and a trusted prefix of bundled migration history; actual database schema, integrity, foreign keys, board documents and attachment references are checked before compatibility is reported. Supported older schemas migrate only on a private staged copy. Future or modified migrations, missing originals, mismatched checksums, malformed databases, and unsupported format versions are rejected.

Use complete ZIP files downloaded by PortFolio. The writer uses store-only ZIP entries for predictable CPU/memory use; the reader supports regular stored or deflated entries with bounded compression ratios. Arbitrary repackaged ZIP files are not guaranteed compatible.

## Storage and recovery

All paths derive from `DATA_DIR`, which defaults to `./data` for source runs and `/data` in the image. No Docker socket, daemon restart, privileged application process or external ZIP utility is needed.

- Private temporary uploads, downloads, extracted snapshots and preview directories are under `DATA_DIR/.browser-backups/`. Previews and downloads expire after 15 minutes. Abandoned server-owned staging is cleared on startup; expired work is cleaned during normal operation.
- Verified pre-restore recovery ZIPs are under `DATA_DIR/backups/recovery/`, accessible only through authenticated Settings download routes. The retention policy is the latest three verified pre-restore backups. Copy a recovery ZIP off-server if longer retention is needed.
- Activation uses an fsynced `.activation.json` journal and `.activation-rollback-<UUID>` directory inside `DATA_DIR`. Before activation commits, startup restores the original components after an interrupted switch. After the new database is usable and the journal commits, startup keeps restored state. The bind-mounted `DATA_DIR` itself never moves.
- If verification/recovery generation fails before activation, current state remains untouched. If activation fails after closing SQLite, the original files are restored before reopening. If rollback cannot be completed, maintenance remains enabled and original/recovery files are preserved; do not delete the journal or rollback directory. Correct storage/permission failures and restart normally so startup can retry recovery. Download a retained recovery ZIP when the application is usable again.

Restored browser sessions are invalidated. API token records restore to their saved state, including expiration/revocation values; review token access after restoring an older backup. The user's only copy of a source ZIP is never modified by browser restore.

## Resource limits and security

Only authenticated shared administrators using browser sessions may create, download, upload, review or confirm backups. PortFolio's existing Host/Origin checks, SameSite/HttpOnly cookies and CSRF checks apply. Integration API bearer credentials cannot authorize these operations. Downloads are private/no-store responses, never public static files. Preview identifiers are opaque, session-bound, expiring and consumed by confirmation.

Default archive and expanded byte limit: 4 GiB. The implementation also bounds individual files, manifest bytes, ZIP entry count, compression ratio and operation duration. Uploads are streamed with byte counting, a 15-minute deadline and interruption cleanup. Snapshot creation and untrusted archive/database verification run in disposable child processes with a 256 MiB V8 heap limit and a hard 15-minute deadline; cancellation waits for the child to stop before removing its private scratch files. The operating system still needs memory for SQLite and filesystem buffers. Archive files are copied and hashed through streams rather than read wholesale into memory. Archive entry names have an exact allowlist; traversal, absolute/backslash paths, duplicate names, symlinks, unsafe entries, encryption, unsupported compression and mismatched manifests are rejected. Checksums provide corruption detection, not proof of who created a backup.

One backup/restore operation runs at a time. During normal backup generation, board editing remains available. Activation rejects new requests with a clear maintenance response and waits for admitted requests, uploads and image processing before touching active files. No destructive tests use an existing data directory.

Allow enough free storage for the uploaded ZIP, extracted and prepared state, a verified pre-restore recovery backup, and the old state retained during activation. Low-disk or permission failures must be resolved before retrying. Application ownership remains the configured UID/GID; runtime never changes host ownership or broadens permissions.

## Docker and source installations

Keep the existing persistent `/data` volume/bind mount. Both `1000:1000` and `568:568` application identities need read/write access to the existing data directory. The read-only root filesystem, dropped capabilities and `no-new-privileges` restrictions remain supported. Backups/recovery archives under `/data` survive container recreation. Do not mount a backup download directory as a public web root.

Source installations use the same browser flow and configured `DATA_DIR`. A lifetime SQLite lease in `DATA_DIR/.instance-lock.sqlite` rejects a second PortFolio server using the same directory. Backup children share a lease tied to the current server identity. Direct SQLite clients and external attachment writers are outside this coordination and must not modify application storage during restoration. Environment changes, Docker upgrades and release management are separate administrative tasks.

## Recommended practice and advanced CLI

Download backups after material documentation changes, before application upgrades, and at least weekly for regularly edited installations. Keep multiple dated off-server copies and periodically validate a restore into a separate test installation. A retained recovery archive on the same disk is not a substitute for an independent backup.

Existing advanced CLI commands remain supported: `pnpm db:backup [destination.sqlite]` creates a consistent snapshot and adjacent `.attachments` directory; keep both together. `DATA_DIR=/new/empty/directory pnpm db:restore snapshot.sqlite` validates/restores into a new directory. CLI recovery never overwrites an existing database. These commands are not required for the browser workflow. Existing v0.4.0 CLI snapshot pairs are not browser ZIP uploads: create/download a complete browser ZIP for browser restoration.

See [installation and operations](INSTALLATION.md#advanced-cli-snapshot-backups) for Docker CLI commands. v0.4.1 introduces no SQL migration; supported older backup schemas are migrated only in staging before activation.
