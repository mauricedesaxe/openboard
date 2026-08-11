ALTER TABLE invitations ADD COLUMN replacement_token TEXT;

WITH replacement_rank AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY replacement_for_invitation_id
      ORDER BY created_at, id
    ) AS replacement_number
  FROM invitations
  WHERE replacement_for_invitation_id IS NOT NULL
)
UPDATE invitations
SET replacement_for_invitation_id = NULL
WHERE id IN (
  SELECT id
  FROM replacement_rank
  WHERE replacement_number > 1
);

CREATE UNIQUE INDEX invitations_one_replacement_per_source_idx
  ON invitations(replacement_for_invitation_id)
  WHERE replacement_for_invitation_id IS NOT NULL;

CREATE TRIGGER invitations_require_replaceable_source
BEFORE INSERT ON invitations
WHEN NEW.replacement_for_invitation_id IS NOT NULL
  AND (
    NEW.replacement_token IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM invitations
      WHERE id = NEW.replacement_for_invitation_id
        AND event_id = NEW.event_id
        AND status = 'revoked'
        AND replacement_token = NEW.replacement_token
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invitation_not_replaceable');
END;
