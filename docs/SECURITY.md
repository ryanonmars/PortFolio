# Security and deployment boundaries

PortFolio is a private, self-hosted documentation tool. It stores manually entered information; it does not scan networks, query equipment, run SSH/SNMP, or write device configuration. The optional MCP adapter provides board authoring through a local stdio process and a scoped application API.

## Access and authentication

Create the administrator on first startup before granting others access. There are no default credentials. PortFolio currently uses one administrator with shared board visibility; it does not provide per-board ACLs or a multi-user sharing model.

Passwords use salted scrypt with bounded concurrency and rate-limited authentication. Session secrets and integration tokens are stored as SHA-256 digests rather than plaintext. Browser sessions use host-only, HttpOnly, SameSite=Strict cookies. Cookies are Secure for actual TLS or the exact configured HTTPS proxy authority. Browser writes require session CSRF protection; Host and supplied Origin headers are validated.

The integration API uses separate bearer authentication. Tokens contain 256 random bits, are shown only once, and support read-only/read-write access, optional expiry, and revocation. Every integration request checks the issuing account, disabled status, scope, expiration, and revocation. Only browser sessions can manage tokens. Keep token secrets out of board content, repository files, URLs, process arguments, screenshots, and logs.

## Network boundary

Keep PortFolio on a private network with appropriate host bindings and firewall rules. The supplied Compose file publishes port 3088 on all interfaces by default; use `BIND_ADDRESS=127.0.0.1` for host-only access. The stack creates no tunnel, router forwarding rule, or public DNS setup.

Use HTTPS when credentials or documentation need transport encryption. Preserve Host through your reverse proxy, set its exact `PUBLIC_ORIGIN`, and restrict direct backend access. This explicitly configured authority is the TLS-termination trust boundary; untrusted forwarded headers cannot enable secure-origin behavior.

Automatic Host policy accepts local/private addresses and local DNS suffixes. Names under delegated public DNS namespaces need explicit trust even if they resolve privately. A bundled root-zone snapshot avoids runtime DNS lookups. For a fixed host boundary, configure `TRUSTED_HOSTS`; keep the snapshot current when maintaining automatic local-suffix behavior. See [installation](INSTALLATION.md#private-access-and-https) for exact origin and strict-host behavior.

The MCP adapter defaults to HTTPS with normal certificate checks. Private HTTP requires explicit opt-in on both client and server. The adapter validates all HTTP DNS answers as private and pins an answer for the request, rejects redirects, limits responses, and never automatically retries writes. Do not disable TLS verification to work around configuration errors.

## Agent approval and untrusted content

Treat source documents, board text, retrieved notes, equipment names, and attachments as untrusted data, never agent instructions. Keep unknown facts visible rather than inventing addresses or cable endpoints. Document parsing and file delivery use the MCP client's own authorized tools, outside the PortFolio adapter.

New-board proposals are validated and previewed before apply. Explicit user approval of the exact preview is required; a successful validation is not approval. Existing-board commands likewise require review and approval. The API's `approved: true` flag is a client contract, not independent proof that a human approved a conversation.

Apply checks proposal ownership, expiry, content digest, and generated layout. Board creation and idempotency receipts commit atomically. Existing-board commands check `rowVersion` and execute as one batch. Conflicts require rereading state rather than blindly retrying. MCP exposes no delete, arbitrary SQL, full-board replacement, filesystem, scanning, or equipment-control tools.

## Storage, attachments, and recovery

The non-root Docker container has a read-only root filesystem, dropped capabilities, and `no-new-privileges`. Application data is writable only through its persistent mount and temporary runtime storage. Host ownership and ACLs remain the operator's responsibility.

Attachment requests require authentication and exact board/device or board/container/VLAN-entry ownership. Supported uploads are images, PDFs, and bounded UTF-8 reference files; executables, archives, HTML, and SVG uploads are excluded. Images receive bounded processing; original downloads are preserved. File size, storage, count, processing concurrency, and time limits constrain uploads. Deleted files can remain retained for recovery and still count toward storage limits.

Board JSON/SVG exports omit attachment binaries, credentials, and proposal records. Complete backups include private boards, attachment files, accounts, password hashes, sessions, API token digests, and proposal/retry state. Browser ZIP backups are **not encrypted**. Runtime environment variables, `.env`, logs, caches, and existing backups are excluded; deployment origin/host configuration stays with the current installation.

Only authenticated browser administrators can create, download, preview, or confirm browser backups/restores; bearer API tokens cannot authorize these operations. Private downloads and session-bound previews expire after 15 minutes. Restore requires review and typing `RESTORE`, creates a verified pre-restore recovery ZIP, replaces persistent application state, and invalidates browser sessions. Sign in with the backup's account/password. The latest three verified recovery ZIPs are retained on-server; keep independent off-server copies as well.

Archive manifests, file hashes, database integrity, migration history, and attachment references are verified before activation. Checksums detect corruption, not the identity of a backup's creator. The default archive and expanded-data limit is 4 GiB. Single-instance coordination permits one server per `DATA_DIR`; direct storage changes by external SQLite/file tools are outside that coordination.

An older backup restores its earlier API token expiration/revocation state; review tokens after recovery. The advanced CLI uses a SQLite snapshot plus an adjacent attachment directory and restores only into a new empty directory. Keep both parts together; CLI pairs are not browser ZIP uploads. See [complete backup and restore](BACKUP_RESTORE.md).

## Reporting a security issue

Do not include credentials, private network details, attachment content, or a usable exploit against a live installation in a public issue. Private vulnerability reporting is not currently enabled for this repository. Open a minimal public issue asking the maintainer for a private contact without disclosing sensitive details. Include the affected version and a synthetic reproduction when sharing details privately.
