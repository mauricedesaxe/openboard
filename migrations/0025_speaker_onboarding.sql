CREATE TABLE task_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('event_speaker', 'program_item', 'program_item_speaker')),
  completion_mechanism TEXT NOT NULL CHECK (completion_mechanism IN ('manual', 'profile', 'form', 'file')),
  profile_requirement TEXT CHECK (profile_requirement IN ('complete', 'bio', 'headshot')),
  form_schema_json TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  CHECK (
    (completion_mechanism = 'profile' AND profile_requirement IS NOT NULL AND form_schema_json IS NULL)
    OR (completion_mechanism = 'form' AND profile_requirement IS NULL AND form_schema_json IS NOT NULL)
    OR (completion_mechanism IN ('manual', 'file') AND profile_requirement IS NULL AND form_schema_json IS NULL)
  )
);

CREATE INDEX task_definitions_event_id_idx ON task_definitions(event_id);

CREATE TABLE task_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  task_definition_id TEXT NOT NULL REFERENCES task_definitions(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  target_user_id TEXT REFERENCES user(id),
  target_program_item_id TEXT REFERENCES program_items(id),
  target_submission_speaker_id TEXT REFERENCES submission_speakers(id),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  due_at TEXT,
  completion_revision INTEGER NOT NULL DEFAULT 1 CHECK (completion_revision > 0),
  assigned_by_user_id TEXT NOT NULL REFERENCES user(id),
  canceled_at INTEGER,
  canceled_by_user_id TEXT REFERENCES user(id),
  created_at INTEGER NOT NULL,
  CHECK (
    (target_user_id IS NOT NULL) +
    (target_program_item_id IS NOT NULL) +
    (target_submission_speaker_id IS NOT NULL) = 1
  )
);

CREATE INDEX task_assignments_event_id_idx ON task_assignments(event_id);
CREATE INDEX task_assignments_target_user_idx ON task_assignments(event_id, target_user_id);
CREATE INDEX task_assignments_target_program_item_idx ON task_assignments(target_program_item_id);
CREATE INDEX task_assignments_target_speaker_idx ON task_assignments(target_submission_speaker_id);

CREATE TRIGGER task_definitions_lock_assigned_shape
BEFORE UPDATE OF scope, completion_mechanism, profile_requirement, form_schema_json ON task_definitions
WHEN EXISTS (
  SELECT 1 FROM task_assignments
  WHERE task_definition_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'assigned_task_definition_locked');
END;

CREATE TRIGGER task_assignments_require_matching_target
BEFORE INSERT ON task_assignments
WHEN NOT EXISTS (
  SELECT 1
  FROM task_definitions
  WHERE task_definitions.id = NEW.task_definition_id
    AND task_definitions.event_id = NEW.event_id
    AND (
      (task_definitions.scope = 'event_speaker' AND NEW.target_user_id IS NOT NULL)
      OR (task_definitions.scope = 'program_item' AND NEW.target_program_item_id IS NOT NULL)
      OR (task_definitions.scope = 'program_item_speaker' AND NEW.target_submission_speaker_id IS NOT NULL)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_task_assignment_target');
END;

CREATE TABLE task_assignment_revisions (
  assignment_id TEXT NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  opened_by_user_id TEXT NOT NULL REFERENCES user(id),
  reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (assignment_id, revision)
);

CREATE TABLE onboarding_form_responses (
  id TEXT PRIMARY KEY NOT NULL,
  assignment_id TEXT NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
  completion_revision INTEGER NOT NULL CHECK (completion_revision > 0),
  answers_json TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES user(id),
  submitted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX onboarding_form_responses_one_draft_idx
  ON onboarding_form_responses(assignment_id, completion_revision)
  WHERE submitted_at IS NULL;

CREATE TRIGGER onboarding_form_responses_freeze_submitted
BEFORE UPDATE ON onboarding_form_responses
WHEN OLD.submitted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'submitted_form_response_immutable');
END;

CREATE TABLE stored_files (
  id TEXT PRIMARY KEY NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  uploaded_by_user_id TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE task_assignment_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  assignment_id TEXT NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
  completion_revision INTEGER NOT NULL CHECK (completion_revision > 0),
  stored_file_id TEXT NOT NULL UNIQUE REFERENCES stored_files(id),
  attached_by_user_id TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX task_assignment_attachments_assignment_idx
  ON task_assignment_attachments(assignment_id, completion_revision);

CREATE TABLE task_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  assignment_id TEXT NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
  completion_revision INTEGER NOT NULL CHECK (completion_revision > 0),
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'profile', 'form', 'file', 'waiver', 'organizer_override')),
  actor_user_id TEXT NOT NULL REFERENCES user(id),
  speaker_profile_id TEXT REFERENCES speaker_profiles(id),
  form_response_id TEXT REFERENCES onboarding_form_responses(id),
  attachment_id TEXT REFERENCES task_assignment_attachments(id),
  reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK (
    (kind = 'profile' AND speaker_profile_id IS NOT NULL AND form_response_id IS NULL AND attachment_id IS NULL AND reason IS NULL)
    OR (kind = 'form' AND speaker_profile_id IS NULL AND form_response_id IS NOT NULL AND attachment_id IS NULL AND reason IS NULL)
    OR (kind = 'file' AND speaker_profile_id IS NULL AND form_response_id IS NULL AND attachment_id IS NOT NULL AND reason IS NULL)
    OR (kind = 'manual' AND speaker_profile_id IS NULL AND form_response_id IS NULL AND attachment_id IS NULL AND reason IS NULL)
    OR (kind IN ('waiver', 'organizer_override') AND speaker_profile_id IS NULL AND form_response_id IS NULL AND attachment_id IS NULL AND length(trim(reason)) > 0)
  )
);

CREATE INDEX task_evidence_assignment_idx
  ON task_evidence(assignment_id, completion_revision);
CREATE UNIQUE INDEX task_evidence_profile_once_idx
  ON task_evidence(assignment_id, completion_revision, speaker_profile_id)
  WHERE kind = 'profile';

CREATE TABLE task_evidence_rejections (
  evidence_id TEXT PRIMARY KEY NOT NULL REFERENCES task_evidence(id) ON DELETE CASCADE,
  rejected_by_user_id TEXT NOT NULL REFERENCES user(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE task_evidence_supersessions (
  previous_evidence_id TEXT PRIMARY KEY NOT NULL REFERENCES task_evidence(id) ON DELETE CASCADE,
  replacement_evidence_id TEXT NOT NULL UNIQUE REFERENCES task_evidence(id) ON DELETE CASCADE,
  superseded_by_user_id TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  CHECK (previous_evidence_id <> replacement_evidence_id)
);

CREATE TABLE task_reminders (
  id TEXT PRIMARY KEY NOT NULL,
  assignment_id TEXT NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
  sent_by_user_id TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX task_reminders_assignment_idx ON task_reminders(assignment_id, created_at);

CREATE TRIGGER task_evidence_prevent_duplicate_form_completion
BEFORE INSERT ON task_evidence
WHEN NEW.kind = 'form'
  AND EXISTS (
    SELECT 1
    FROM task_evidence AS existing
    LEFT JOIN task_evidence_rejections
      ON task_evidence_rejections.evidence_id = existing.id
    LEFT JOIN task_evidence_supersessions
      ON task_evidence_supersessions.previous_evidence_id = existing.id
    WHERE existing.assignment_id = NEW.assignment_id
      AND existing.completion_revision = NEW.completion_revision
      AND existing.kind = 'form'
      AND task_evidence_rejections.evidence_id IS NULL
      AND task_evidence_supersessions.previous_evidence_id IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'current_form_evidence_exists');
END;

CREATE TRIGGER task_assignments_add_existing_profile_evidence
AFTER INSERT ON task_assignments
WHEN NEW.target_user_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM task_definitions
    INNER JOIN speaker_profiles ON speaker_profiles.user_id = NEW.target_user_id
    WHERE task_definitions.id = NEW.task_definition_id
      AND task_definitions.completion_mechanism = 'profile'
      AND (
        (task_definitions.profile_requirement = 'complete'
          AND length(trim(speaker_profiles.display_name)) > 0
          AND length(trim(speaker_profiles.bio)) > 0)
        OR (task_definitions.profile_requirement = 'bio'
          AND length(trim(speaker_profiles.bio)) > 0)
        OR (task_definitions.profile_requirement = 'headshot'
          AND length(trim(COALESCE(speaker_profiles.headshot_url, ''))) > 0)
      )
  )
BEGIN
  INSERT OR IGNORE INTO task_evidence (
    id, assignment_id, completion_revision, kind, actor_user_id,
    speaker_profile_id, created_at
  )
  SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
      lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
      lower(hex(randomblob(6))),
    NEW.id, NEW.completion_revision, 'profile', NEW.target_user_id,
    speaker_profiles.id, unixepoch('subsec') * 1000
  FROM speaker_profiles
  WHERE speaker_profiles.user_id = NEW.target_user_id;
END;

CREATE TRIGGER task_assignments_add_reopened_profile_evidence
AFTER UPDATE OF completion_revision ON task_assignments
WHEN NEW.target_user_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM task_definitions
    INNER JOIN speaker_profiles ON speaker_profiles.user_id = NEW.target_user_id
    WHERE task_definitions.id = NEW.task_definition_id
      AND task_definitions.completion_mechanism = 'profile'
      AND (
        (task_definitions.profile_requirement = 'complete'
          AND length(trim(speaker_profiles.display_name)) > 0
          AND length(trim(speaker_profiles.bio)) > 0)
        OR (task_definitions.profile_requirement = 'bio'
          AND length(trim(speaker_profiles.bio)) > 0)
        OR (task_definitions.profile_requirement = 'headshot'
          AND length(trim(COALESCE(speaker_profiles.headshot_url, ''))) > 0)
      )
  )
BEGIN
  INSERT OR IGNORE INTO task_evidence (
    id, assignment_id, completion_revision, kind, actor_user_id,
    speaker_profile_id, created_at
  )
  SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
      lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
      lower(hex(randomblob(6))),
    NEW.id, NEW.completion_revision, 'profile', NEW.target_user_id,
    speaker_profiles.id, unixepoch('subsec') * 1000
  FROM speaker_profiles
  WHERE speaker_profiles.user_id = NEW.target_user_id;
END;

CREATE TRIGGER speaker_profiles_add_task_evidence_after_insert
AFTER INSERT ON speaker_profiles
BEGIN
  INSERT OR IGNORE INTO task_evidence (
    id, assignment_id, completion_revision, kind, actor_user_id,
    speaker_profile_id, created_at
  )
  SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
      lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
      lower(hex(randomblob(6))),
    task_assignments.id, task_assignments.completion_revision, 'profile',
    NEW.user_id, NEW.id, unixepoch('subsec') * 1000
  FROM task_assignments
  INNER JOIN task_definitions
    ON task_definitions.id = task_assignments.task_definition_id
  WHERE task_assignments.target_user_id = NEW.user_id
    AND task_assignments.canceled_at IS NULL
    AND task_definitions.completion_mechanism = 'profile'
    AND (
      (task_definitions.profile_requirement = 'complete'
        AND length(trim(NEW.display_name)) > 0
        AND length(trim(NEW.bio)) > 0)
      OR (task_definitions.profile_requirement = 'bio'
        AND length(trim(NEW.bio)) > 0)
      OR (task_definitions.profile_requirement = 'headshot'
        AND length(trim(COALESCE(NEW.headshot_url, ''))) > 0)
    );
END;

CREATE TRIGGER speaker_profiles_add_task_evidence_after_update
AFTER UPDATE OF display_name, bio, headshot_url ON speaker_profiles
BEGIN
  INSERT OR IGNORE INTO task_evidence (
    id, assignment_id, completion_revision, kind, actor_user_id,
    speaker_profile_id, created_at
  )
  SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
      lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
      lower(hex(randomblob(6))),
    task_assignments.id, task_assignments.completion_revision, 'profile',
    NEW.user_id, NEW.id, unixepoch('subsec') * 1000
  FROM task_assignments
  INNER JOIN task_definitions
    ON task_definitions.id = task_assignments.task_definition_id
  WHERE task_assignments.target_user_id = NEW.user_id
    AND task_assignments.canceled_at IS NULL
    AND task_definitions.completion_mechanism = 'profile'
    AND (
      (task_definitions.profile_requirement = 'complete'
        AND length(trim(NEW.display_name)) > 0
        AND length(trim(NEW.bio)) > 0)
      OR (task_definitions.profile_requirement = 'bio'
        AND length(trim(NEW.bio)) > 0)
      OR (task_definitions.profile_requirement = 'headshot'
        AND length(trim(COALESCE(NEW.headshot_url, ''))) > 0)
    );
END;
