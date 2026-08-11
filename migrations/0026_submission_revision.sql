ALTER TABLE submissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE submissions ADD COLUMN write_token TEXT NOT NULL DEFAULT '';
ALTER TABLE form_responses ADD COLUMN write_token TEXT NOT NULL DEFAULT '';

DROP TRIGGER form_responses_require_editable_update;

CREATE TRIGGER form_responses_require_editable_update
BEFORE UPDATE OF answers_json ON form_responses
WHEN NOT EXISTS (
  SELECT 1
  FROM submissions
  INNER JOIN decisions ON decisions.submission_id = submissions.id
  WHERE submissions.id = NEW.submission_id
    AND submissions.status = 'active'
    AND submissions.write_token = NEW.write_token
    AND decisions.status NOT IN ('accepted', 'declined')
)
BEGIN
  SELECT RAISE(ABORT, 'submission_closed');
END;
