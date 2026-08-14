CREATE TABLE problem_report_rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  report_count INTEGER NOT NULL
);
