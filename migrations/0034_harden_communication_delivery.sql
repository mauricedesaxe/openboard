DROP TRIGGER communications_are_immutable_update;

UPDATE communications
SET event_id = (
      SELECT submissions.event_id
      FROM submissions
      WHERE submissions.id = communications.submission_id
    ),
    recipient_key = 'user:' || recipient_user_id
WHERE submission_id IS NOT NULL
  AND recipient_user_id IS NOT NULL;

CREATE TRIGGER communications_are_immutable_update
BEFORE UPDATE ON communications BEGIN SELECT RAISE(ABORT, 'immutable_communication'); END;

ALTER TABLE agenda_delivery_work ADD COLUMN retry_eligible INTEGER NOT NULL DEFAULT 1;

CREATE TRIGGER agenda_delivery_snapshots_are_immutable
BEFORE UPDATE ON agenda_delivery_work
WHEN NEW.destination IS NOT OLD.destination
  OR NEW.subject IS NOT OLD.subject
  OR NEW.body IS NOT OLD.body
BEGIN SELECT RAISE(ABORT, 'immutable_agenda_delivery_snapshot'); END;

DROP TRIGGER communications_are_immutable_delete;
DROP TRIGGER communication_delivery_attempts_are_immutable_delete;
