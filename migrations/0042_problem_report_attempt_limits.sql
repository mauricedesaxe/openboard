ALTER TABLE problem_report_rate_limits
ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

UPDATE problem_report_rate_limits
SET attempt_count = report_count;
