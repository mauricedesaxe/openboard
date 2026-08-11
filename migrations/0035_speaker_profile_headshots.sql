ALTER TABLE speaker_profiles
  ADD COLUMN headshot_stored_file_id TEXT REFERENCES stored_files(id);

DROP TRIGGER task_assignments_add_existing_profile_evidence;
DROP TRIGGER task_assignments_add_reopened_profile_evidence;
DROP TRIGGER speaker_profiles_add_task_evidence_after_insert;
DROP TRIGGER speaker_profiles_add_task_evidence_after_update;
DROP TRIGGER published_agenda_speakers_require_current_source;

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
          AND (speaker_profiles.headshot_url IS NOT NULL
            OR speaker_profiles.headshot_stored_file_id IS NOT NULL))
      )
  )
BEGIN
  INSERT OR IGNORE INTO task_evidence (
    id, assignment_id, completion_revision, kind, actor_user_id,
    speaker_profile_id, created_at
  )
  SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) ||
      substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
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
          AND (speaker_profiles.headshot_url IS NOT NULL
            OR speaker_profiles.headshot_stored_file_id IS NOT NULL))
      )
  )
BEGIN
  INSERT OR IGNORE INTO task_evidence (
    id, assignment_id, completion_revision, kind, actor_user_id,
    speaker_profile_id, created_at
  )
  SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) ||
      substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
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
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) ||
      substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
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
        AND (NEW.headshot_url IS NOT NULL
          OR NEW.headshot_stored_file_id IS NOT NULL))
    );
END;

CREATE TRIGGER speaker_profiles_add_task_evidence_after_update
AFTER UPDATE OF display_name, bio, headshot_url, headshot_stored_file_id ON speaker_profiles
BEGIN
  INSERT OR IGNORE INTO task_evidence (
    id, assignment_id, completion_revision, kind, actor_user_id,
    speaker_profile_id, created_at
  )
  SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) ||
      substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
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
        AND (NEW.headshot_url IS NOT NULL
          OR NEW.headshot_stored_file_id IS NOT NULL))
    );
END;

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
    AND COALESCE(submission_speakers.claimed_user_id, '') = COALESCE(NEW.source_claimed_user_id, '')
    AND COALESCE(speaker_profiles.bio, '') = COALESCE(NEW.bio, '')
    AND COALESCE(
      CASE
        WHEN speaker_profiles.headshot_stored_file_id IS NOT NULL
          THEN '/api/speaker-headshots/' || speaker_profiles.headshot_stored_file_id
        ELSE speaker_profiles.headshot_url
      END,
      ''
    ) = COALESCE(NEW.headshot_url, '')
    AND submission_speakers.position = NEW.position
)
BEGIN
  SELECT RAISE(ABORT, 'stale_agenda_publication');
END;
