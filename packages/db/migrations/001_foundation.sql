CREATE TABLE app_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

INSERT INTO app_metadata (key, value) VALUES ('application', 'PortFolio');
