ALTER TABLE agenda_items
  ADD COLUMN placed INTEGER NOT NULL DEFAULT 1 CHECK (placed IN (0, 1));

ALTER TABLE agenda_items
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

DROP TRIGGER agenda_publications_require_complete_current_source_finalize;

CREATE TRIGGER agenda_publications_require_complete_current_source_finalize
BEFORE UPDATE OF finalized ON agenda_publications
WHEN OLD.finalized = 0
  AND NEW.finalized = 1
  AND OLD.requires_finalization = 1
  AND (
    NOT EXISTS (
      SELECT 1 FROM agendas
      WHERE agendas.id = OLD.agenda_id
        AND agendas.event_id = OLD.event_id
        AND agendas.revision = OLD.working_revision
    )
    OR (SELECT COUNT(*) FROM published_agenda_items WHERE publication_id = OLD.id)
      != (SELECT COUNT(*) FROM agenda_items WHERE agenda_id = OLD.agenda_id AND placed = 1)
    OR (
      SELECT COUNT(*)
      FROM published_agenda_speakers
      INNER JOIN published_agenda_items
        ON published_agenda_items.id = published_agenda_speakers.published_agenda_item_id
      WHERE published_agenda_items.publication_id = OLD.id
    ) != (
      SELECT COUNT(*)
      FROM agenda_items
      INNER JOIN program_items ON program_items.id = agenda_items.program_item_id
      INNER JOIN submission_speakers
        ON submission_speakers.submission_id = program_items.submission_id
        AND submission_speakers.removed_at IS NULL
      WHERE agenda_items.agenda_id = OLD.agenda_id
        AND agenda_items.kind = 'program'
        AND agenda_items.placed = 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'stale_agenda_publication');
END;

DROP TRIGGER published_agenda_items_require_current_source;

CREATE TRIGGER published_agenda_items_require_current_source
BEFORE INSERT ON published_agenda_items
WHEN NOT EXISTS (
  SELECT 1
  FROM agenda_publications
  INNER JOIN agenda_items
    ON agenda_items.id = NEW.agenda_item_id
    AND agenda_items.agenda_id = agenda_publications.agenda_id
    AND agenda_items.event_id = agenda_publications.event_id
    AND agenda_items.placed = 1
  LEFT JOIN rooms ON rooms.id = agenda_items.room_id
  LEFT JOIN program_items ON program_items.id = agenda_items.program_item_id
  LEFT JOIN submissions ON submissions.id = program_items.submission_id
  LEFT JOIN decisions ON decisions.submission_id = submissions.id
  LEFT JOIN tracks ON tracks.id = submissions.track_id
  WHERE agenda_publications.id = NEW.publication_id
    AND agenda_items.kind = NEW.kind
    AND COALESCE(agenda_items.program_item_id, '') = COALESCE(NEW.program_item_id, '')
    AND COALESCE(agenda_items.room_id, '') = COALESCE(NEW.room_id, '')
    AND (agenda_items.canceled_at IS NOT NULL) = NEW.canceled
    AND (
      (NEW.kind = 'program' AND NEW.canceled = 1)
      OR (
        COALESCE(rooms.name, '') = COALESCE(NEW.room_name, '')
        AND COALESCE(rooms.position, -1) = COALESCE(NEW.room_position, -1)
        AND rooms.archived_at IS NULL
        AND (
          (NEW.kind = 'service' AND agenda_items.service_title = NEW.title)
          OR
          (NEW.kind = 'program'
            AND submissions.title = NEW.title
            AND submissions.abstract = NEW.abstract
            AND submissions.format = NEW.format
            AND submissions.status = 'active'
            AND decisions.status = 'accepted'
            AND tracks.id = NEW.track_id
            AND tracks.name = NEW.track_name
            AND tracks.position = NEW.track_position
            AND tracks.archived_at IS NULL)
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'stale_agenda_publication');
END;
