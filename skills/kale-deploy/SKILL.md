---
name: kale-deploy
description: Use when building or adapting a web application for the Kale Deploy runtime on Cloudflare Workers. This Gemini extension entrypoint delegates to the canonical Kale Deploy skill bundled in this repository.
---

# Kale Deploy

Use this skill when the target runtime is Kale Deploy.

The canonical Kale Deploy instructions for this repository live at:

- `plugins/kale-deploy/skills/kale-deploy/SKILL.md`

When this skill is triggered:

1. Open `plugins/kale-deploy/skills/kale-deploy/SKILL.md` in this installed extension checkout.
2. Follow that file as the source of truth for build, GitHub, Kale connection, validation, deployment, and secret-management behavior.
3. Prefer the canonical file if this Gemini entrypoint and the bundled plugin skill ever diverge.
