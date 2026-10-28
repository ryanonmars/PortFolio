CREATE TABLE device_templates (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  type TEXT NOT NULL CHECK (type IN ('router','switch','firewall','ap','server','custom','other')),
  description TEXT NOT NULL DEFAULT '',
  groups_json TEXT NOT NULL CHECK (json_valid(groups_json) AND json_type(groups_json)='array'),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX device_templates_unique_name ON device_templates(lower(name));
