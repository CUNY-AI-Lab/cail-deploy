# Connection Health

Use this file when Kale is already reachable and the question is what to trust next.

## Live policy beats local lore

If Kale tools are available:

1. call `get_runtime_manifest`
2. call `test_connection`
3. prefer the live response fields over local plugin or skill wording

Important live fields:

- `dynamic_skill_policy`
- `client_update_policy`
- `agent_harnesses`
- `dynamicSkillPolicy`
- `clientUpdatePolicy`
- `harnesses`
- `nextAction`
- `summary`

If the harness can determine its local wrapper metadata, pass:

- `harness`
- `localBundleVersion`

to `test_connection` so Kale can warn about stale local wrapper copy.

## Readiness

Only say Kale is ready when:

- `test_connection` succeeds
- `register_project` is available
- any remaining GitHub handoff is explained plainly

GitHub App approval is repository-specific. If no repository has been chosen yet, say the environment is ready for the next GitHub-backed step instead of claiming every future repo is already connected.
