CREATE TABLE racks (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '',
  order_index INTEGER NOT NULL CHECK (order_index BETWEEN 0 AND 65535),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (id, site_id)
) STRICT;
CREATE UNIQUE INDEX racks_unique_name ON racks(site_id, lower(name));
CREATE INDEX racks_site_order ON racks(site_id, order_index);

CREATE TABLE vlans (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  vlan_id INTEGER NOT NULL CHECK (vlan_id BETWEEN 1 AND 4094),
  name TEXT NOT NULL DEFAULT '',
  color_hex TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (id, site_id),
  UNIQUE (site_id, vlan_id)
) STRICT;
CREATE INDEX vlans_site ON vlans(site_id, vlan_id);

CREATE TABLE subnets (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  vlan_ref TEXT,
  cidr TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  gateway_ip TEXT,
  dns_servers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dns_servers_json) AND json_type(dns_servers_json) = 'array'),
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (id, site_id),
  UNIQUE (site_id, cidr),
  FOREIGN KEY (vlan_ref, site_id) REFERENCES vlans(id, site_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX subnets_site ON subnets(site_id);

CREATE TABLE dhcp_scopes (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  subnet_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  start_ip TEXT NOT NULL,
  end_ip TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  FOREIGN KEY (subnet_id, site_id) REFERENCES subnets(id, site_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX dhcp_scopes_subnet ON dhcp_scopes(subnet_id);

CREATE TABLE devices (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  rack_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('router','switch','firewall','ap','server','custom','other')),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  hostname TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  serial TEXT NOT NULL DEFAULT '',
  management_ip TEXT NOT NULL DEFAULT '',
  mac TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  metadata_tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(metadata_tags_json) AND json_type(metadata_tags_json) = 'array'),
  order_index INTEGER NOT NULL CHECK (order_index BETWEEN 0 AND 65535),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (id, site_id),
  FOREIGN KEY (rack_id, site_id) REFERENCES racks(id, site_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX devices_unique_name ON devices(site_id, lower(display_name));
CREATE INDEX devices_site_order ON devices(site_id, order_index);

CREATE TABLE ports (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  order_index INTEGER NOT NULL CHECK (order_index BETWEEN 0 AND 65535),
  kind TEXT NOT NULL CHECK (kind IN ('rj45','sfp','sfp_plus','qsfp','other')),
  speed TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL CHECK (mode IN ('access','trunk','routed','disabled','other')),
  documented_link_state TEXT NOT NULL DEFAULT 'unknown' CHECK (documented_link_state IN ('unknown','up','down')),
  native_vlan_ref TEXT,
  pvid INTEGER CHECK (pvid BETWEEN 1 AND 4094),
  description TEXT NOT NULL DEFAULT '',
  external_destination_label TEXT NOT NULL DEFAULT '',
  face TEXT NOT NULL DEFAULT 'front' CHECK (face IN ('front','rear')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (id, site_id),
  UNIQUE (device_id, order_index),
  FOREIGN KEY (device_id, site_id) REFERENCES devices(id, site_id) ON DELETE CASCADE,
  FOREIGN KEY (native_vlan_ref, site_id) REFERENCES vlans(id, site_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX ports_unique_name ON ports(device_id, lower(name));
CREATE INDEX ports_site_device ON ports(site_id, device_id, order_index);

CREATE TABLE port_tagged_vlans (
  port_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  vlan_ref TEXT NOT NULL,
  PRIMARY KEY (port_id, vlan_ref),
  FOREIGN KEY (port_id, site_id) REFERENCES ports(id, site_id) ON DELETE CASCADE,
  FOREIGN KEY (vlan_ref, site_id) REFERENCES vlans(id, site_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX port_tagged_vlans_vlan ON port_tagged_vlans(vlan_ref);

CREATE TRIGGER tagged_vlan_insert_guard BEFORE INSERT ON port_tagged_vlans
WHEN EXISTS (SELECT 1 FROM ports WHERE id = NEW.port_id AND site_id = NEW.site_id AND (mode = 'access' OR native_vlan_ref = NEW.vlan_ref))
BEGIN
  SELECT RAISE(ABORT, 'Invalid tagged VLAN membership');
END;
CREATE TRIGGER tagged_vlan_update_guard BEFORE UPDATE ON port_tagged_vlans
WHEN EXISTS (SELECT 1 FROM ports WHERE id = NEW.port_id AND site_id = NEW.site_id AND (mode = 'access' OR native_vlan_ref = NEW.vlan_ref))
BEGIN
  SELECT RAISE(ABORT, 'Invalid tagged VLAN membership');
END;
CREATE TRIGGER port_configuration_update_guard BEFORE UPDATE OF native_vlan_ref, mode ON ports
WHEN EXISTS (SELECT 1 FROM port_tagged_vlans WHERE port_id = NEW.id AND (vlan_ref = NEW.native_vlan_ref OR NEW.mode = 'access'))
BEGIN
  SELECT RAISE(ABORT, 'Invalid port VLAN configuration');
END;
