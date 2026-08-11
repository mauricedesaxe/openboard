ALTER TABLE submission_speakers ADD COLUMN claimed_user_id TEXT REFERENCES user(id);

CREATE UNIQUE INDEX submission_speakers_active_claim_idx
  ON submission_speakers(submission_id, claimed_user_id)
  WHERE claimed_user_id IS NOT NULL AND removed_at IS NULL;

CREATE TABLE submission_speaker_invitations (
  id TEXT PRIMARY KEY NOT NULL,
  submission_speaker_id TEXT NOT NULL REFERENCES submission_speakers(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  invited_by_user_id TEXT NOT NULL REFERENCES user(id),
  replacement_for_invitation_id TEXT REFERENCES submission_speaker_invitations(id),
  accepted_by_user_id TEXT REFERENCES user(id),
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX submission_speaker_invitations_speaker_id_idx
  ON submission_speaker_invitations(submission_speaker_id);
CREATE INDEX submission_speaker_invitations_email_idx
  ON submission_speaker_invitations(email);
CREATE UNIQUE INDEX submission_speaker_invitations_pending_idx
  ON submission_speaker_invitations(submission_speaker_id)
  WHERE status = 'pending';

CREATE TRIGGER submission_speakers_keep_one_active
BEFORE UPDATE OF removed_at ON submission_speakers
WHEN NEW.removed_at IS NOT NULL
  AND OLD.removed_at IS NULL
  AND EXISTS (
    SELECT 1 FROM submissions
    WHERE submissions.id = NEW.submission_id
      AND submissions.status = 'active'
  )
  AND (
    SELECT COUNT(*) FROM submission_speakers
    WHERE submission_id = NEW.submission_id
      AND removed_at IS NULL
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_submission_speaker');
END;

CREATE TABLE speaker_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL,
  headshot_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
