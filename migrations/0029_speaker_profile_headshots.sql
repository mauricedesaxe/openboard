ALTER TABLE speaker_profiles
  ADD COLUMN headshot_stored_file_id TEXT REFERENCES stored_files(id);
