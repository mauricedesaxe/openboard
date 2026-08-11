CREATE TABLE speaker_profile_headshots (
  speaker_profile_id TEXT PRIMARY KEY NOT NULL REFERENCES speaker_profiles(id) ON DELETE CASCADE,
  stored_file_id TEXT NOT NULL UNIQUE REFERENCES stored_files(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
