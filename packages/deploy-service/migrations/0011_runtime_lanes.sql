ALTER TABLE projects
  ADD COLUMN runtime_lane TEXT NOT NULL DEFAULT 'dedicated_worker'
  CHECK(runtime_lane IN ('dedicated_worker', 'shared_static', 'shared_app'));

ALTER TABLE projects
  ADD COLUMN recommended_runtime_lane TEXT NOT NULL DEFAULT 'dedicated_worker'
  CHECK(recommended_runtime_lane IN ('dedicated_worker', 'shared_static', 'shared_app'));

ALTER TABLE deployments
  ADD COLUMN runtime_lane TEXT NOT NULL DEFAULT 'dedicated_worker'
  CHECK(runtime_lane IN ('dedicated_worker', 'shared_static', 'shared_app'));

ALTER TABLE deployments
  ADD COLUMN recommended_runtime_lane TEXT NOT NULL DEFAULT 'dedicated_worker'
  CHECK(recommended_runtime_lane IN ('dedicated_worker', 'shared_static', 'shared_app'));
