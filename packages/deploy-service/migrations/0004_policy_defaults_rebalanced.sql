UPDATE project_policies
SET max_validations_per_day = 0
WHERE max_validations_per_day = 10;

UPDATE project_policies
SET max_deployments_per_day = 0
WHERE max_deployments_per_day = 10;

UPDATE project_policies
SET max_asset_bytes = 94371840
WHERE max_asset_bytes = 262144000;
