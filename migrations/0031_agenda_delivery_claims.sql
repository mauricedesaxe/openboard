DROP INDEX agenda_delivery_attempts_work_idx;
DROP INDEX agenda_delivery_work_pending_idx;

CREATE TABLE agenda_delivery_work_with_claims (
  id TEXT PRIMARY KEY NOT NULL,
  publication_id TEXT NOT NULL REFERENCES agenda_publications(id) ON DELETE CASCADE,
  agenda_item_id TEXT NOT NULL REFERENCES agenda_items(id),
  recipient_key TEXT,
  recipient_user_id TEXT REFERENCES user(id),
  destination TEXT,
  recipient_name TEXT,
  action TEXT NOT NULL CHECK (action IN ('publish', 'update', 'cancel', 'restore')),
  calendar_uid TEXT NOT NULL,
  calendar_sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'failed', 'completed', 'superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  claimed_at INTEGER,
  claim_token TEXT,
  completed_at INTEGER,
  superseded_at INTEGER,
  last_error TEXT,
  UNIQUE (publication_id, agenda_item_id, recipient_key, destination, action)
);

INSERT INTO agenda_delivery_work_with_claims (
  id,
  publication_id,
  agenda_item_id,
  recipient_key,
  recipient_user_id,
  destination,
  recipient_name,
  action,
  calendar_uid,
  calendar_sequence,
  created_at,
  status,
  attempt_count,
  next_attempt_at,
  claimed_at,
  completed_at,
  superseded_at,
  last_error
)
SELECT
  id,
  publication_id,
  agenda_item_id,
  recipient_key,
  recipient_user_id,
  destination,
  recipient_name,
  action,
  calendar_uid,
  calendar_sequence,
  created_at,
  status,
  attempt_count,
  next_attempt_at,
  claimed_at,
  completed_at,
  superseded_at,
  last_error
FROM agenda_delivery_work;

CREATE TABLE agenda_delivery_attempts_with_claims (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL REFERENCES agenda_delivery_work_with_claims(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('delivered', 'failed', 'superseded')),
  error TEXT,
  UNIQUE (work_id, attempt_number)
);

INSERT INTO agenda_delivery_attempts_with_claims
SELECT * FROM agenda_delivery_attempts;

DROP TABLE agenda_delivery_attempts;
DROP TABLE agenda_delivery_work;
ALTER TABLE agenda_delivery_work_with_claims RENAME TO agenda_delivery_work;
ALTER TABLE agenda_delivery_attempts_with_claims RENAME TO agenda_delivery_attempts;

CREATE INDEX agenda_delivery_work_pending_idx
  ON agenda_delivery_work(status, next_attempt_at, created_at);
CREATE INDEX agenda_delivery_attempts_work_idx
  ON agenda_delivery_attempts(work_id, attempt_number);
