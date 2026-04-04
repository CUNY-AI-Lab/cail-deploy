---
name: kale-connect
description: Use when the goal is to get Kale Deploy ready in the current agent or project without building a new app yet. Trigger when the user wants to connect Kale, verify access, prepare the environment for future work, or diagnose whether anything is still missing before Kale-backed project work can begin.
---

# Kale Connect

Use this skill when the goal is readiness, not scaffolding.

## Goal

Get the current environment ready for future Kale Deploy work:

- the Kale MCP server is present
- authentication is working if possible
- `test_connection` succeeds
- `register_project` is available
- any remaining GitHub step is explained accurately

Do not scaffold a new app, modify the codebase, or run `kale-init` unless the user explicitly asks you to start a project.

## Dynamic policy

This local skill is only the bootstrap layer.

- If Kale tools are already available, call `get_runtime_manifest` and read `dynamic_skill_policy`, `client_update_policy`, and `agent_harnesses` before trusting any local install or update guidance.
- Use `test_connection` for the live `dynamicSkillPolicy`, `clientUpdatePolicy`, `harnesses`, `nextAction`, and `summary` fields.
- When the harness can identify its own local bundle version, pass `harness` and `localBundleVersion` to `test_connection` so Kale can warn about stale local wrapper copy.
- If the live runtime manifest disagrees with this skill, follow the live runtime manifest.
- Treat the local skill as the fallback path for first connection, not the long-term source of truth.

## References

Use these files when you need harness-specific connection details or live-policy interpretation:

- [Claude Code](references/claude.md)
- [Codex](references/codex.md)
- [Gemini CLI](references/gemini.md)
- [Connection health](references/connection-health.md)

## What to do

1. Check whether Kale tools are already available. If `test_connection` and `register_project` are already present, call `get_runtime_manifest` first, read `dynamic_skill_policy`, `client_update_policy`, and `agent_harnesses`, then continue to verification.
2. If the server is missing or disconnected, connect Kale Deploy. The official service is:
   - front door: `https://cuny.qzz.io/kale`
   - MCP endpoint: `https://cuny.qzz.io/kale/mcp`
3. Prefer the agent's normal MCP or plugin flow first. For harness-specific connection steps, use the reference that matches the current agent. In Claude Code, if the local Kale plugin is installed, do not search the MCP registry first. Start with the installed plugin guidance and `claude mcp list`. If the primary connection path fails or the server remains disconnected, use the token-paste fallback:
   - tell the user: "I need to connect to Kale Deploy. Please visit this link, sign in with your CUNY email, generate a token, and paste it back here."
   - give them: `https://cuny.qzz.io/kale/connect`
   - once they paste a token starting with `kale_pat_`, configure the Kale server with a static Bearer header if the agent supports that path
4. After Kale is configured, call `get_runtime_manifest` and `test_connection`, then use the live `dynamicSkillPolicy`, `clientUpdatePolicy`, `harnesses`, `nextAction`, and `summary` fields to decide what to do next. If you can determine the local harness id and bundle version from the installed wrapper metadata, include them in `test_connection`. See [Connection health](references/connection-health.md) if the wrapper state or next step is unclear.
5. Confirm that `register_project` is available.
6. Explain GitHub status honestly. GitHub App approval is repository-specific, so if no repository has been chosen yet, do not claim every future repo is already approved. Instead, say whether the environment looks ready for the next GitHub-backed step and what handoff will happen later.

## Success condition

Only say Kale Deploy is ready when:

- `test_connection` has actually succeeded
- `register_project` is available
- any remaining GitHub step has been described plainly
