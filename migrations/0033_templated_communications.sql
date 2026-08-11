CREATE TABLE communication_templates (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'submission_confirmation',
    'decision_acceptance',
    'decision_decline',
    'task_reminder',
    'agenda_invitation',
    'agenda_update',
    'agenda_cancellation'
  )),
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (event_id, purpose)
);

INSERT INTO communication_templates
  (id, event_id, purpose, subject_template, body_template, created_at, updated_at)
SELECT
  events.id || ':submission_confirmation',
  events.id,
  'submission_confirmation',
  'Proposal received: {{submissionTitle}}',
  'We received {{submissionTitle}} for {{eventName}}.',
  CAST(unixepoch('subsec') * 1000 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM events;

INSERT INTO communication_templates
  (id, event_id, purpose, subject_template, body_template, created_at, updated_at)
SELECT events.id || ':decision_acceptance', events.id, 'decision_acceptance',
  'Accepted: {{submissionTitle}}',
  '{{submissionTitle}} was accepted for {{eventName}}.',
  CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM events;

INSERT INTO communication_templates
  (id, event_id, purpose, subject_template, body_template, created_at, updated_at)
SELECT events.id || ':decision_decline', events.id, 'decision_decline',
  'Decision: {{submissionTitle}}',
  '{{submissionTitle}} was not selected for {{eventName}}.',
  CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM events;

INSERT INTO communication_templates
  (id, event_id, purpose, subject_template, body_template, created_at, updated_at)
SELECT events.id || ':task_reminder', events.id, 'task_reminder',
  'Reminder: {{taskName}}',
  '{{recipientName}}, {{taskName}} for {{eventName}} is still incomplete.',
  CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM events;

INSERT INTO communication_templates
  (id, event_id, purpose, subject_template, body_template, created_at, updated_at)
SELECT events.id || ':agenda_invitation', events.id, 'agenda_invitation',
  'Invitation: {{sessionTitle}} at {{eventName}}',
  '{{recipientName}}, your calendar invitation for {{sessionTitle}} is attached.',
  CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM events;

INSERT INTO communication_templates
  (id, event_id, purpose, subject_template, body_template, created_at, updated_at)
SELECT events.id || ':agenda_update', events.id, 'agenda_update',
  'Updated: {{sessionTitle}} at {{eventName}}',
  '{{recipientName}}, your calendar entry for {{sessionTitle}} was updated.',
  CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM events;

INSERT INTO communication_templates
  (id, event_id, purpose, subject_template, body_template, created_at, updated_at)
SELECT events.id || ':agenda_cancellation', events.id, 'agenda_cancellation',
  'Canceled: {{sessionTitle}} at {{eventName}}',
  '{{recipientName}}, your calendar entry for {{sessionTitle}} was canceled.',
  CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM events;

ALTER TABLE communications ADD COLUMN event_id TEXT REFERENCES events(id);
ALTER TABLE communications ADD COLUMN recipient_key TEXT;
ALTER TABLE communications ADD COLUMN recipient_invitation_id TEXT;
ALTER TABLE communications ADD COLUMN subject TEXT;
ALTER TABLE communications ADD COLUMN body TEXT;
ALTER TABLE communications ADD COLUMN context_json TEXT;
ALTER TABLE communications ADD COLUMN template_revision INTEGER;

CREATE UNIQUE INDEX communications_deduplicated_key_idx
  ON communications(submission_id, recipient_key, purpose)
  WHERE submission_id IS NOT NULL AND recipient_key IS NOT NULL;

CREATE TABLE communication_delivery_work (
  id TEXT PRIMARY KEY NOT NULL,
  communication_id TEXT NOT NULL UNIQUE REFERENCES communications(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'failed', 'completed', 'terminal')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  claimed_at INTEGER,
  claim_token TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX communication_delivery_work_pending_idx
  ON communication_delivery_work(status, next_attempt_at, created_at);

CREATE TABLE communication_delivery_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL REFERENCES communication_delivery_work(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('delivered', 'retryable_failure', 'terminal_failure')),
  provider_id TEXT,
  error TEXT,
  UNIQUE (work_id, attempt_number)
);

ALTER TABLE agenda_delivery_work ADD COLUMN subject TEXT;
ALTER TABLE agenda_delivery_work ADD COLUMN body TEXT;

CREATE TRIGGER communications_are_immutable_update
BEFORE UPDATE ON communications BEGIN SELECT RAISE(ABORT, 'immutable_communication'); END;
CREATE TRIGGER communications_are_immutable_delete
BEFORE DELETE ON communications BEGIN SELECT RAISE(ABORT, 'immutable_communication'); END;
CREATE TRIGGER communication_delivery_attempts_are_immutable_update
BEFORE UPDATE ON communication_delivery_attempts BEGIN SELECT RAISE(ABORT, 'immutable_communication_attempt'); END;
CREATE TRIGGER communication_delivery_attempts_are_immutable_delete
BEFORE DELETE ON communication_delivery_attempts BEGIN SELECT RAISE(ABORT, 'immutable_communication_attempt'); END;
