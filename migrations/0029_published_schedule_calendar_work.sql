ALTER TABLE published_agenda_items ADD COLUMN calendar_uid TEXT;
ALTER TABLE published_agenda_items ADD COLUMN calendar_sequence INTEGER;

ALTER TABLE agenda_delivery_work
  ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'failed', 'completed', 'superseded'));
ALTER TABLE agenda_delivery_work ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agenda_delivery_work ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE agenda_delivery_work ADD COLUMN claimed_at INTEGER;
ALTER TABLE agenda_delivery_work ADD COLUMN completed_at INTEGER;
ALTER TABLE agenda_delivery_work ADD COLUMN superseded_at INTEGER;
ALTER TABLE agenda_delivery_work ADD COLUMN last_error TEXT;

CREATE INDEX agenda_delivery_work_pending_idx
  ON agenda_delivery_work(status, next_attempt_at, created_at);

CREATE TABLE agenda_delivery_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL REFERENCES agenda_delivery_work(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('delivered', 'failed', 'superseded')),
  error TEXT,
  UNIQUE (work_id, attempt_number)
);

CREATE INDEX agenda_delivery_attempts_work_idx
  ON agenda_delivery_attempts(work_id, attempt_number);
