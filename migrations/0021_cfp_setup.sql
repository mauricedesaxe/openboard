CREATE TABLE tracks (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX tracks_event_id_idx ON tracks(event_id);
CREATE UNIQUE INDEX tracks_active_name_idx
  ON tracks(event_id, lower(name))
  WHERE archived_at IS NULL;

CREATE TABLE rooms (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX rooms_event_id_idx ON rooms(event_id);
CREATE UNIQUE INDEX rooms_active_name_idx
  ON rooms(event_id, lower(name))
  WHERE archived_at IS NULL;

CREATE TABLE cfps (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'open')),
  formats_json TEXT NOT NULL,
  custom_fields_json TEXT NOT NULL,
  structure_locked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX cfps_event_id_idx ON cfps(event_id);
CREATE UNIQUE INDEX cfps_one_open_per_event_idx
  ON cfps(event_id)
  WHERE status = 'open';
CREATE UNIQUE INDEX cfps_one_draft_per_event_idx
  ON cfps(event_id)
  WHERE status = 'draft';
