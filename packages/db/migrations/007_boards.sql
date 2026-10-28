CREATE TABLE board_groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 240),
  order_index INTEGER NOT NULL DEFAULT 0 CHECK (order_index BETWEEN 0 AND 1000000000),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX board_groups_order ON board_groups(order_index,id);

CREATE TABLE boards (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT REFERENCES board_groups(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 240),
  order_index INTEGER NOT NULL DEFAULT 0 CHECK (order_index BETWEEN 0 AND 1000000000),
  document_json TEXT NOT NULL CHECK (json_valid(document_json) AND json_type(document_json)='object'),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX boards_group_order ON boards(group_id,order_index,id);

-- Independent ledgers intentionally survive deletion of either converted record.
-- A user's explicit board/group deletion must never be reversed by restart.
CREATE TABLE board_legacy_groups (
  legacy_workspace_id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT REFERENCES board_groups(id) ON DELETE SET NULL,
  converted_at INTEGER NOT NULL
) STRICT;
CREATE TABLE board_legacy_sites (
  legacy_site_id TEXT PRIMARY KEY NOT NULL,
  legacy_workspace_id TEXT NOT NULL,
  board_id TEXT REFERENCES boards(id) ON DELETE SET NULL,
  converted_at INTEGER NOT NULL
) STRICT;
