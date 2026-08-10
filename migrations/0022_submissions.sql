CREATE TABLE submissions (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  cfp_id TEXT NOT NULL REFERENCES cfps(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES user(id),
  client_draft_id TEXT NOT NULL,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  title TEXT NOT NULL,
  abstract TEXT NOT NULL,
  format TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'withdrawn')),
  withdrawn_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX submissions_event_id_idx ON submissions(event_id);
CREATE INDEX submissions_owner_user_id_idx ON submissions(owner_user_id);
CREATE UNIQUE INDEX submissions_owner_draft_idx
  ON submissions(cfp_id, owner_user_id, client_draft_id);

CREATE TABLE submission_speakers (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  invited_name TEXT NOT NULL,
  invited_email TEXT NOT NULL,
  position INTEGER NOT NULL,
  removed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX submission_speakers_submission_id_idx
  ON submission_speakers(submission_id);

CREATE TABLE form_responses (
  id TEXT PRIMARY KEY NOT NULL,
  cfp_id TEXT NOT NULL REFERENCES cfps(id),
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  answers_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'accept_queued', 'decline_queued', 'accepted', 'declined')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE communications (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  recipient_user_id TEXT REFERENCES user(id),
  destination TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX communications_submission_id_idx ON communications(submission_id);
