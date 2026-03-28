# Student Quickstart

Kale Deploy is a publishing tool from the CUNY AI Lab. It is meant to feel simple:

1. sign in with your CUNY email
2. ask your agent to connect Kale Deploy
3. ask your agent to make the app
4. approve GitHub once
5. open the live site

## Fast path

If you are starting from scratch:

1. Open [https://cuny.qzz.io/kale](https://cuny.qzz.io/kale)
2. Choose Claude Code, Codex, or Gemini CLI
3. Copy the setup prompt for that agent
4. Paste it into the agent
5. Then paste the build prompt and describe what you want to make

Your agent should handle the setup step first, then continue with the project.

If you already have a GitHub repo, skip to “If you already have a repo” below.

## Step by step

### 1. Connect your agent

Open the CAIL homepage:

- [https://cuny.qzz.io/kale](https://cuny.qzz.io/kale)

Choose your agent and copy the setup prompt:

- Claude Code
- Codex
- Gemini CLI

Paste that prompt into the agent.

The goal is for the agent to connect Kale Deploy for you, rather than asking you to type setup commands by hand.

### 2. Ask the agent to build the app

Use the build prompt from the homepage, or say something like:

- “Build me a small web app with Kale Deploy.”
- “Make a simple guestbook site with Kale Deploy.”
- “Create an exhibit site and publish it with Kale Deploy.”

If the agent starts from a blank project, it will usually create a CAIL-compatible repo structure for you.

That normally includes files like:

- `src/index.ts`
- `package.json`
- `wrangler.jsonc`
- `AGENTS.md`

### 3. Push to GitHub

Your agent should create or connect a GitHub repository and push the code.

If it asks you to approve GitHub or choose a repository name, do that in the browser.

### 4. Approve GitHub once

Kale Deploy needs one GitHub approval per repository.

When the agent hands you a GitHub step:

1. Open the CAIL setup page or GitHub link it gives you.
2. Approve `CAIL Deploy` for the repository.
3. Return to the setup page if needed.

If you are testing multiple repositories, make sure the GitHub install includes the correct one.

### 5. Push to `main`

After GitHub is connected, make a commit and push to `main`.

Kale Deploy watches the repository default branch, so `main` is the normal path.

### 6. Watch GitHub

On the commit page, look for the Kale Deploy check.

You should see one of these:

- `Live`
- `Needs adaptation for CAIL`
- `Unsupported on CAIL`

### 7. Open the live app

Live project URLs use this shape:

- `https://<project-name>.cuny.qzz.io`

Example:

- [https://cail-deploy-smoke-test.cuny.qzz.io](https://cail-deploy-smoke-test.cuny.qzz.io)

## What kinds of projects work best

Kale Deploy works best for:

- small websites
- exhibits
- course or project sites
- simple APIs
- forms and guestbooks
- D1-backed projects
- Worker-compatible Hono apps

It is not a general-purpose Linux server host.

## If you already have a repo

That can still work.

The simplest path is:

1. Open [https://cuny.qzz.io/kale](https://cuny.qzz.io/kale)
2. Use **Check whether a GitHub repo is connected**
3. Enter `owner/repo`
4. Follow the GitHub approval step if Kale Deploy is not connected yet

Your repo still needs to fit the Kale Deploy runtime.

Good signs:

- it uses TypeScript or JavaScript
- it has a Worker-style entrypoint
- it already uses Hono or a Worker-compatible framework

Warning signs:

- Python backend
- Express or another traditional Node server
- native modules
- local SQLite files
- long-running background jobs

If you are unsure, push the repo and read the GitHub check result. It should tell you whether the project is ready, needs adaptation, or is unsupported.

## If something goes wrong

Start here:

- [troubleshooting.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/troubleshooting.md)
- [support-matrix.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/support-matrix.md)
