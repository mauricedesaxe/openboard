CREATE TABLE submission_file_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  cfp_id TEXT NOT NULL REFERENCES cfps(id) ON DELETE CASCADE,
  client_draft_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES user(id),
  stored_file_id TEXT NOT NULL UNIQUE REFERENCES stored_files(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX submission_file_uploads_draft_idx
  ON submission_file_uploads(cfp_id, owner_user_id, client_draft_id);

CREATE TABLE form_response_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  form_response_id TEXT NOT NULL REFERENCES form_responses(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  stored_file_id TEXT NOT NULL UNIQUE REFERENCES stored_files(id),
  created_at INTEGER NOT NULL,
  UNIQUE (form_response_id, field_key)
);

CREATE INDEX form_response_attachments_response_idx
  ON form_response_attachments(form_response_id);
