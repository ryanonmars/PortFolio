CREATE TABLE port_custom_field_defs (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('text','number','boolean','select','date')),
  choices_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(choices_json) AND json_type(choices_json)='array'),
  default_value_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(default_value_json)),
  visible_by_default INTEGER NOT NULL DEFAULT 1 CHECK (visible_by_default IN (0,1)),
  column_order INTEGER NOT NULL DEFAULT 100 CHECK (column_order BETWEEN 0 AND 65535),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, site_id),
  UNIQUE (site_id, key)
) STRICT;
CREATE INDEX port_custom_field_defs_site ON port_custom_field_defs(site_id,column_order);

CREATE TABLE port_custom_values (
  port_id TEXT NOT NULL,
  field_def_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json) AND json_type(value_json) IN ('text','integer','real','true','false','null')),
  PRIMARY KEY (port_id,field_def_id),
  FOREIGN KEY (port_id,site_id) REFERENCES ports(id,site_id) ON DELETE CASCADE,
  FOREIGN KEY (field_def_id,site_id) REFERENCES port_custom_field_defs(id,site_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX port_custom_values_field ON port_custom_values(field_def_id);

CREATE TABLE connections (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  endpoint_a_port_id TEXT NOT NULL,
  endpoint_b_port_id TEXT NOT NULL,
  cable_type TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (endpoint_a_port_id != endpoint_b_port_id),
  FOREIGN KEY (endpoint_a_port_id,site_id) REFERENCES ports(id,site_id) ON DELETE RESTRICT,
  FOREIGN KEY (endpoint_b_port_id,site_id) REFERENCES ports(id,site_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX connections_site ON connections(site_id);
CREATE INDEX connections_endpoint_a ON connections(endpoint_a_port_id);
CREATE INDEX connections_endpoint_b ON connections(endpoint_b_port_id);

CREATE TRIGGER connection_insert_occupancy BEFORE INSERT ON connections
WHEN EXISTS (
  SELECT 1 FROM connections WHERE endpoint_a_port_id IN (NEW.endpoint_a_port_id,NEW.endpoint_b_port_id)
    OR endpoint_b_port_id IN (NEW.endpoint_a_port_id,NEW.endpoint_b_port_id)
)
BEGIN
  SELECT RAISE(ABORT, 'A port already has a documented connection');
END;
CREATE TRIGGER connection_update_occupancy BEFORE UPDATE OF endpoint_a_port_id,endpoint_b_port_id ON connections
WHEN EXISTS (
  SELECT 1 FROM connections WHERE id != OLD.id AND
    (endpoint_a_port_id IN (NEW.endpoint_a_port_id,NEW.endpoint_b_port_id)
      OR endpoint_b_port_id IN (NEW.endpoint_a_port_id,NEW.endpoint_b_port_id))
)
BEGIN
  SELECT RAISE(ABORT, 'A port already has a documented connection');
END;
