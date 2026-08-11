ALTER TABLE agendas ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE agenda_items (
  id TEXT PRIMARY KEY NOT NULL,
  agenda_id TEXT NOT NULL REFERENCES agendas(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('program', 'service')),
  program_item_id TEXT UNIQUE REFERENCES program_items(id),
  service_scope TEXT CHECK (service_scope IN ('event', 'room')),
  service_title TEXT,
  room_id TEXT REFERENCES rooms(id),
  starts_at_local TEXT NOT NULL,
  ends_at_local TEXT NOT NULL,
  canceled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (kind = 'program' AND program_item_id IS NOT NULL AND service_scope IS NULL AND service_title IS NULL)
    OR
    (kind = 'service' AND program_item_id IS NULL AND service_scope IS NOT NULL AND service_title IS NOT NULL
      AND ((service_scope = 'event' AND room_id IS NULL) OR (service_scope = 'room' AND room_id IS NOT NULL)))
  )
);

CREATE INDEX agenda_items_agenda_id_idx ON agenda_items(agenda_id);
CREATE INDEX agenda_items_event_id_idx ON agenda_items(event_id);

CREATE TRIGGER agenda_items_require_event_scope_insert
BEFORE INSERT ON agenda_items
WHEN NOT EXISTS (
  SELECT 1 FROM agendas
  WHERE agendas.id = NEW.agenda_id AND agendas.event_id = NEW.event_id
)
OR (NEW.room_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM rooms WHERE rooms.id = NEW.room_id AND rooms.event_id = NEW.event_id
))
OR (NEW.kind = 'program' AND NOT EXISTS (
  SELECT 1
  FROM program_items
  INNER JOIN submissions ON submissions.id = program_items.submission_id
  INNER JOIN decisions ON decisions.submission_id = submissions.id
  WHERE program_items.id = NEW.program_item_id
    AND program_items.event_id = NEW.event_id
    AND submissions.status = 'active'
    AND decisions.status = 'accepted'
))
BEGIN
  SELECT RAISE(ABORT, 'invalid_agenda_item_scope');
END;

CREATE TRIGGER agenda_items_require_event_scope_update
BEFORE UPDATE ON agenda_items
WHEN NOT EXISTS (
  SELECT 1 FROM agendas
  WHERE agendas.id = NEW.agenda_id AND agendas.event_id = NEW.event_id
)
OR (NEW.room_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM rooms WHERE rooms.id = NEW.room_id AND rooms.event_id = NEW.event_id
))
OR (NEW.kind = 'program' AND NOT EXISTS (
  SELECT 1
  FROM program_items
  INNER JOIN submissions ON submissions.id = program_items.submission_id
  INNER JOIN decisions ON decisions.submission_id = submissions.id
  WHERE program_items.id = NEW.program_item_id
    AND program_items.event_id = NEW.event_id
    AND submissions.status = 'active'
    AND decisions.status = 'accepted'
))
BEGIN
  SELECT RAISE(ABORT, 'invalid_agenda_item_scope');
END;

CREATE TRIGGER agenda_items_increment_revision_insert
AFTER INSERT ON agenda_items
BEGIN
  UPDATE agendas
  SET revision = revision + 1,
      updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE id = NEW.agenda_id;
END;

CREATE TRIGGER agenda_items_increment_revision_update
AFTER UPDATE ON agenda_items
BEGIN
  UPDATE agendas
  SET revision = revision + 1,
      updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE id = NEW.agenda_id;
END;

CREATE TRIGGER agenda_items_increment_revision_delete
AFTER DELETE ON agenda_items
BEGIN
  UPDATE agendas
  SET revision = revision + 1,
      updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE id = OLD.agenda_id;
END;

CREATE TABLE agenda_publications (
  id TEXT PRIMARY KEY NOT NULL,
  agenda_id TEXT NOT NULL REFERENCES agendas(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  working_revision INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  published_by_user_id TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  UNIQUE (agenda_id, revision)
);

CREATE INDEX agenda_publications_event_revision_idx
  ON agenda_publications(event_id, revision DESC);

CREATE TRIGGER agenda_publications_require_current_working_revision
BEFORE INSERT ON agenda_publications
WHEN NOT EXISTS (
  SELECT 1
  FROM agendas
  INNER JOIN events ON events.id = agendas.event_id
  WHERE agendas.id = NEW.agenda_id
    AND agendas.event_id = NEW.event_id
    AND agendas.revision = NEW.working_revision
    AND events.name = NEW.event_name
    AND events.timezone = NEW.timezone
    AND events.starts_on = NEW.starts_on
    AND events.ends_on = NEW.ends_on
)
OR NEW.revision != COALESCE((
  SELECT MAX(revision) + 1 FROM agenda_publications WHERE agenda_id = NEW.agenda_id
), 1)
BEGIN
  SELECT RAISE(ABORT, 'stale_agenda_publication');
END;

CREATE TABLE published_agenda_items (
  id TEXT PRIMARY KEY NOT NULL,
  publication_id TEXT NOT NULL REFERENCES agenda_publications(id) ON DELETE CASCADE,
  agenda_item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('program', 'service')),
  program_item_id TEXT,
  title TEXT NOT NULL,
  abstract TEXT,
  format TEXT,
  track_id TEXT,
  track_name TEXT,
  track_position INTEGER,
  room_id TEXT,
  room_name TEXT,
  room_position INTEGER,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  canceled INTEGER NOT NULL DEFAULT 0 CHECK (canceled IN (0, 1)),
  UNIQUE (publication_id, agenda_item_id)
);

CREATE INDEX published_agenda_items_publication_time_idx
  ON published_agenda_items(publication_id, starts_at, room_position);

CREATE TRIGGER published_agenda_items_require_current_source
BEFORE INSERT ON published_agenda_items
WHEN NOT EXISTS (
  SELECT 1
  FROM agenda_publications
  INNER JOIN agenda_items
    ON agenda_items.id = NEW.agenda_item_id
    AND agenda_items.agenda_id = agenda_publications.agenda_id
    AND agenda_items.event_id = agenda_publications.event_id
  LEFT JOIN rooms ON rooms.id = agenda_items.room_id
  LEFT JOIN program_items ON program_items.id = agenda_items.program_item_id
  LEFT JOIN submissions ON submissions.id = program_items.submission_id
  LEFT JOIN decisions ON decisions.submission_id = submissions.id
  LEFT JOIN tracks ON tracks.id = submissions.track_id
  WHERE agenda_publications.id = NEW.publication_id
    AND agenda_items.kind = NEW.kind
    AND COALESCE(agenda_items.program_item_id, '') = COALESCE(NEW.program_item_id, '')
    AND COALESCE(agenda_items.room_id, '') = COALESCE(NEW.room_id, '')
    AND COALESCE(rooms.name, '') = COALESCE(NEW.room_name, '')
    AND COALESCE(rooms.position, -1) = COALESCE(NEW.room_position, -1)
    AND rooms.archived_at IS NULL
    AND (agenda_items.canceled_at IS NOT NULL) = NEW.canceled
    AND (
      (NEW.kind = 'service' AND agenda_items.service_title = NEW.title)
      OR
      (NEW.kind = 'program'
        AND submissions.title = NEW.title
        AND submissions.abstract = NEW.abstract
        AND submissions.format = NEW.format
        AND submissions.status = 'active'
        AND decisions.status = 'accepted'
        AND tracks.id = NEW.track_id
        AND tracks.name = NEW.track_name
        AND tracks.position = NEW.track_position
        AND tracks.archived_at IS NULL)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'stale_agenda_publication');
END;

CREATE TABLE published_agenda_speakers (
  id TEXT PRIMARY KEY NOT NULL,
  published_agenda_item_id TEXT NOT NULL REFERENCES published_agenda_items(id) ON DELETE CASCADE,
  submission_speaker_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT,
  headshot_url TEXT,
  position INTEGER NOT NULL,
  UNIQUE (published_agenda_item_id, submission_speaker_id)
);

CREATE TRIGGER published_agenda_speakers_require_current_source
BEFORE INSERT ON published_agenda_speakers
WHEN NOT EXISTS (
  SELECT 1
  FROM published_agenda_items
  INNER JOIN program_items ON program_items.id = published_agenda_items.program_item_id
  INNER JOIN submission_speakers
    ON submission_speakers.id = NEW.submission_speaker_id
    AND submission_speakers.submission_id = program_items.submission_id
    AND submission_speakers.removed_at IS NULL
  LEFT JOIN speaker_profiles ON speaker_profiles.user_id = submission_speakers.claimed_user_id
  WHERE published_agenda_items.id = NEW.published_agenda_item_id
    AND COALESCE(speaker_profiles.display_name, submission_speakers.invited_name) = NEW.display_name
    AND COALESCE(speaker_profiles.bio, '') = COALESCE(NEW.bio, '')
    AND COALESCE(speaker_profiles.headshot_url, '') = COALESCE(NEW.headshot_url, '')
    AND submission_speakers.position = NEW.position
)
BEGIN
  SELECT RAISE(ABORT, 'stale_agenda_publication');
END;

CREATE TABLE calendar_sync_states (
  agenda_item_id TEXT PRIMARY KEY NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  uid TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL,
  canceled INTEGER NOT NULL CHECK (canceled IN (0, 1)),
  fingerprint TEXT NOT NULL,
  publication_id TEXT NOT NULL REFERENCES agenda_publications(id),
  updated_at INTEGER NOT NULL
);

CREATE TABLE agenda_delivery_work (
  id TEXT PRIMARY KEY NOT NULL,
  publication_id TEXT NOT NULL REFERENCES agenda_publications(id) ON DELETE CASCADE,
  agenda_item_id TEXT NOT NULL REFERENCES agenda_items(id),
  action TEXT NOT NULL CHECK (action IN ('publish', 'update', 'cancel', 'restore')),
  calendar_uid TEXT NOT NULL,
  calendar_sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  created_at INTEGER NOT NULL,
  UNIQUE (publication_id, agenda_item_id)
);

CREATE TRIGGER agenda_publications_are_immutable_update
BEFORE UPDATE ON agenda_publications BEGIN SELECT RAISE(ABORT, 'immutable_agenda_publication'); END;
CREATE TRIGGER agenda_publications_are_immutable_delete
BEFORE DELETE ON agenda_publications BEGIN SELECT RAISE(ABORT, 'immutable_agenda_publication'); END;
CREATE TRIGGER published_agenda_items_are_immutable_update
BEFORE UPDATE ON published_agenda_items BEGIN SELECT RAISE(ABORT, 'immutable_agenda_publication'); END;
CREATE TRIGGER published_agenda_items_are_immutable_delete
BEFORE DELETE ON published_agenda_items BEGIN SELECT RAISE(ABORT, 'immutable_agenda_publication'); END;
CREATE TRIGGER published_agenda_speakers_are_immutable_update
BEFORE UPDATE ON published_agenda_speakers BEGIN SELECT RAISE(ABORT, 'immutable_agenda_publication'); END;
CREATE TRIGGER published_agenda_speakers_are_immutable_delete
BEFORE DELETE ON published_agenda_speakers BEGIN SELECT RAISE(ABORT, 'immutable_agenda_publication'); END;
