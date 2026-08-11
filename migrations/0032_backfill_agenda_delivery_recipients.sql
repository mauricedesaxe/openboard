INSERT OR IGNORE INTO agenda_delivery_work (
  id,
  publication_id,
  agenda_item_id,
  recipient_key,
  recipient_user_id,
  destination,
  recipient_name,
  action,
  calendar_uid,
  calendar_sequence,
  created_at
)
SELECT
  legacy.id || ':' || published_agenda_speakers.id,
  legacy.publication_id,
  legacy.agenda_item_id,
  COALESCE(
    published_agenda_speakers.source_claimed_user_id,
    'speaker:' || published_agenda_speakers.submission_speaker_id
  ),
  published_agenda_speakers.source_claimed_user_id,
  COALESCE(user.email, submission_speakers.invited_email),
  published_agenda_speakers.display_name,
  legacy.action,
  legacy.calendar_uid,
  legacy.calendar_sequence,
  legacy.created_at
FROM agenda_delivery_work AS legacy
INNER JOIN published_agenda_items
  ON published_agenda_items.publication_id = legacy.publication_id
  AND published_agenda_items.agenda_item_id = legacy.agenda_item_id
INNER JOIN published_agenda_speakers
  ON published_agenda_speakers.published_agenda_item_id = published_agenda_items.id
LEFT JOIN user
  ON user.id = published_agenda_speakers.source_claimed_user_id
LEFT JOIN submission_speakers
  ON submission_speakers.id = published_agenda_speakers.submission_speaker_id
WHERE legacy.recipient_key IS NULL
  AND COALESCE(user.email, submission_speakers.invited_email) IS NOT NULL;
