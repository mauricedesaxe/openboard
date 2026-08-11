CREATE TABLE review_rounds (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  cfp_id TEXT NOT NULL UNIQUE REFERENCES cfps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'closed')),
  opened_at INTEGER,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX review_rounds_event_id_idx ON review_rounds(event_id);

INSERT INTO review_rounds (
  id, event_id, cfp_id, name, status, opened_at, created_at, updated_at
)
SELECT id, event_id, id, name || ' review', 'draft', NULL, created_at, updated_at
FROM cfps;

ALTER TABLE reviewer_assignments RENAME TO reviewer_assignments_legacy;

CREATE TABLE reviewer_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  review_round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  reviewer_user_id TEXT NOT NULL REFERENCES user(id),
  assigned_by_user_id TEXT NOT NULL REFERENCES user(id),
  revoked_at INTEGER,
  revoked_by_user_id TEXT REFERENCES user(id),
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO reviewer_assignments (
  id, event_id, review_round_id, submission_id, reviewer_user_id,
  assigned_by_user_id, revoked_at, revoked_by_user_id, created_at
)
SELECT
  legacy.id, legacy.event_id, review_rounds.id, legacy.submission_id,
  legacy.reviewer_user_id, legacy.assigned_by_user_id, legacy.revoked_at,
  legacy.revoked_by_user_id, legacy.created_at
FROM reviewer_assignments_legacy AS legacy
INNER JOIN submissions
  ON submissions.id = legacy.submission_id
  AND submissions.event_id = legacy.event_id
INNER JOIN review_rounds
  ON review_rounds.cfp_id = submissions.cfp_id
  AND review_rounds.event_id = legacy.event_id;

DROP TABLE reviewer_assignments_legacy;

CREATE INDEX reviewer_assignments_event_reviewer_idx
  ON reviewer_assignments(event_id, reviewer_user_id);
CREATE UNIQUE INDEX reviewer_assignments_active_idx
  ON reviewer_assignments(review_round_id, submission_id, reviewer_user_id)
  WHERE revoked_at IS NULL;

CREATE TRIGGER reviewer_assignments_require_active_scope
BEFORE INSERT ON reviewer_assignments
WHEN NOT EXISTS (
  SELECT 1
  FROM review_rounds
  INNER JOIN submissions
    ON submissions.cfp_id = review_rounds.cfp_id
    AND submissions.event_id = review_rounds.event_id
  INNER JOIN event_roles
    ON event_roles.event_id = review_rounds.event_id
    AND event_roles.user_id = NEW.reviewer_user_id
    AND event_roles.role = 'reviewer'
    AND event_roles.revoked_at IS NULL
  WHERE review_rounds.id = NEW.review_round_id
    AND review_rounds.event_id = NEW.event_id
    AND review_rounds.status IN ('draft', 'open')
    AND submissions.id = NEW.submission_id
    AND submissions.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_reviewer_assignment');
END;

CREATE TABLE reviews (
  id TEXT PRIMARY KEY NOT NULL,
  assignment_id TEXT NOT NULL UNIQUE REFERENCES reviewer_assignments(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TRIGGER reviews_require_open_assignment_insert
BEFORE INSERT ON reviews
WHEN NOT EXISTS (
  SELECT 1
  FROM reviewer_assignments
  INNER JOIN review_rounds ON review_rounds.id = reviewer_assignments.review_round_id
  INNER JOIN submissions ON submissions.id = reviewer_assignments.submission_id
  WHERE reviewer_assignments.id = NEW.assignment_id
    AND reviewer_assignments.revoked_at IS NULL
    AND review_rounds.status = 'open'
    AND submissions.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'review_round_not_open');
END;

CREATE TRIGGER reviews_require_open_assignment_update
BEFORE UPDATE OF score, comment ON reviews
WHEN NOT EXISTS (
  SELECT 1
  FROM reviewer_assignments
  INNER JOIN review_rounds ON review_rounds.id = reviewer_assignments.review_round_id
  INNER JOIN submissions ON submissions.id = reviewer_assignments.submission_id
  WHERE reviewer_assignments.id = NEW.assignment_id
    AND reviewer_assignments.revoked_at IS NULL
    AND review_rounds.status = 'open'
    AND submissions.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'review_round_not_open');
END;

ALTER TABLE decisions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE program_items (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX program_items_event_id_idx ON program_items(event_id);

CREATE TABLE decision_publications (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  review_round_id TEXT NOT NULL REFERENCES review_rounds(id),
  published_by_user_id TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL
);

CREATE TRIGGER review_rounds_forbid_reopen_after_publication
BEFORE UPDATE OF status ON review_rounds
WHEN OLD.status = 'closed'
  AND NEW.status = 'open'
  AND EXISTS (
    SELECT 1
    FROM decision_publications
    WHERE review_round_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'published_outcome_exists');
END;

CREATE TABLE decision_publication_items (
  id TEXT PRIMARY KEY NOT NULL,
  publication_id TEXT NOT NULL REFERENCES decision_publications(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'declined')),
  expected_revision INTEGER NOT NULL
);

CREATE TRIGGER decision_publication_items_require_current_queue
BEFORE INSERT ON decision_publication_items
WHEN NOT EXISTS (
  SELECT 1
  FROM decision_publications
  INNER JOIN review_rounds
    ON review_rounds.id = decision_publications.review_round_id
    AND review_rounds.event_id = decision_publications.event_id
  INNER JOIN decisions ON decisions.id = NEW.decision_id
  INNER JOIN submissions
    ON submissions.id = decisions.submission_id
    AND submissions.event_id = decision_publications.event_id
    AND submissions.cfp_id = review_rounds.cfp_id
  WHERE decision_publications.id = NEW.publication_id
    AND review_rounds.status = 'closed'
    AND submissions.status = 'active'
    AND decisions.revision = NEW.expected_revision
    AND decisions.status = CASE NEW.outcome
      WHEN 'accepted' THEN 'accept_queued'
      ELSE 'decline_queued'
    END
)
BEGIN
  SELECT RAISE(ABORT, 'stale_decision_publication');
END;

CREATE TABLE review_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES user(id),
  publication_item_id TEXT NOT NULL UNIQUE
    REFERENCES decision_publication_items(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX review_audit_events_event_id_idx ON review_audit_events(event_id);

CREATE UNIQUE INDEX communications_deduplicated_recipient_idx
  ON communications(submission_id, recipient_user_id, purpose)
  WHERE submission_id IS NOT NULL AND recipient_user_id IS NOT NULL;
