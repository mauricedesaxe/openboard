CREATE TABLE invitations (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('organizer', 'reviewer')),
  secret_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  invited_by_user_id TEXT NOT NULL REFERENCES user(id),
  replacement_for_invitation_id TEXT REFERENCES invitations(id),
  accepted_by_user_id TEXT REFERENCES user(id),
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX invitations_event_id_idx ON invitations(event_id);
CREATE INDEX invitations_email_idx ON invitations(email);
CREATE UNIQUE INDEX invitations_pending_grant_idx
  ON invitations(event_id, email, role)
  WHERE status = 'pending';

CREATE TABLE event_roles (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id),
  role TEXT NOT NULL CHECK (role IN ('organizer', 'reviewer')),
  invitation_id TEXT REFERENCES invitations(id),
  granted_by_user_id TEXT NOT NULL REFERENCES user(id),
  revoked_at INTEGER,
  revoked_by_user_id TEXT REFERENCES user(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX event_roles_event_id_idx ON event_roles(event_id);
CREATE INDEX event_roles_user_id_idx ON event_roles(user_id);
CREATE UNIQUE INDEX event_roles_active_grant_idx
  ON event_roles(event_id, user_id, role)
  WHERE revoked_at IS NULL;

CREATE TABLE reviewer_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  review_round_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  reviewer_user_id TEXT NOT NULL REFERENCES user(id),
  assigned_by_user_id TEXT NOT NULL REFERENCES user(id),
  revoked_at INTEGER,
  revoked_by_user_id TEXT REFERENCES user(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX reviewer_assignments_event_reviewer_idx
  ON reviewer_assignments(event_id, reviewer_user_id);
CREATE UNIQUE INDEX reviewer_assignments_active_idx
  ON reviewer_assignments(review_round_id, submission_id, reviewer_user_id)
  WHERE revoked_at IS NULL;
