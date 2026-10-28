CREATE TABLE logical_connections (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  endpoint_a_device_id TEXT NOT NULL,
  endpoint_b_device_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 120),
  protocol TEXT NOT NULL DEFAULT '' CHECK (length(protocol) <= 120),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (endpoint_a_device_id != endpoint_b_device_id),
  FOREIGN KEY (endpoint_a_device_id, site_id) REFERENCES devices(id, site_id) ON DELETE RESTRICT,
  FOREIGN KEY (endpoint_b_device_id, site_id) REFERENCES devices(id, site_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX logical_connections_site ON logical_connections(site_id, id);
CREATE INDEX logical_connections_endpoint_a ON logical_connections(endpoint_a_device_id);
CREATE INDEX logical_connections_endpoint_b ON logical_connections(endpoint_b_device_id);
