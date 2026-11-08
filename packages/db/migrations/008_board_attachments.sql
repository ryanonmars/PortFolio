CREATE TABLE board_attachments (
 id TEXT PRIMARY KEY NOT NULL,
 board_id TEXT NOT NULL,
 owner_type TEXT NOT NULL CHECK(owner_type IN ('device','network')),
 element_id TEXT NOT NULL,
 entry_id TEXT NOT NULL DEFAULT '',
 original_filename TEXT NOT NULL,
 display_name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 mime_type TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
 stored_bytes INTEGER NOT NULL CHECK(stored_bytes >= size_bytes),
 original_sha256 TEXT NOT NULL,
 width INTEGER,
 height INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 row_version INTEGER NOT NULL DEFAULT 1,
 orphaned_at INTEGER,
 deleted_at INTEGER
) STRICT;
CREATE INDEX board_attachments_owner ON board_attachments(board_id,owner_type,element_id,entry_id);
CREATE TABLE attachment_backup_leases (
 id TEXT PRIMARY KEY NOT NULL,
 expires_at INTEGER NOT NULL
) STRICT;
