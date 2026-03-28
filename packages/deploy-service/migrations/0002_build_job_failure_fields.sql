ALTER TABLE build_jobs ADD COLUMN error_kind TEXT
  CHECK(error_kind IN ('build_failure', 'needs_adaptation', 'unsupported'));

ALTER TABLE build_jobs ADD COLUMN error_detail TEXT;
