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
3. Install Kale once in that agent
4. Then use the build prompt on the page and describe what you want to make

Your agent should pick up Kale after install, handle the connection step, and then continue with the project.

If you already have a GitHub repo, skip to “If you already have a repo” below.

## Step by step

### 1. Install Kale once in your agent

Open the Kale homepage:

- [https://cuny.qzz.io/kale](https://cuny.qzz.io/kale)

Choose your agent and run the install instruction shown on the page:

- Claude Code
- Codex
- Gemini CLI

Paste that install instruction into the app you use.

The install step is meant to be global for that agent, not just for one folder.

The website lists short install instructions for the Kale add-on in each agent. After the add-on is installed, use the build prompt on the page and let the agent handle the rest.

Current Claude note:

- Claude Code works most reliably through the token path right now.
- The homepage starts Claude with the in-app `/plugin` install commands for `kale-deploy`.
- In practice, that plugin guidance usually leads Claude to send you to [https://cuny.qzz.io/kale/connect](https://cuny.qzz.io/kale/connect), do the token handoff, and then verify that Kale tools are really available.
- If you use Kale from more than one computer, reuse the same Claude token on both machines for now. Generating a new one at `/connect` currently revokes the previous active token.
- Do not use Claude's interactive `/mcp` screen for Kale right now.

### 2. Ask the agent to build the app

Use the build prompt from the homepage, or say something like:

- “Build me a small web app with Kale Deploy.”
- “Make a simple guestbook site with Kale Deploy.”
- “Create an exhibit site and publish it with Kale Deploy.”

If the agent starts from a blank project, it will usually create the project structure Kale needs for you.

### 3. Push to GitHub

Your agent should create or connect a GitHub repository and push the code.

If it asks you to approve GitHub or choose a repository name, do that in the browser.

### 4. Approve GitHub once

Kale Deploy needs one GitHub approval per repository.

When the agent hands you a GitHub step:

1. Open the Kale setup page or GitHub link it gives you.
2. Approve `Kale Deploy` for the repository.
3. Return to the setup page if needed.

If you are testing multiple repositories, make sure the GitHub install includes the correct one.

### 5. Push to `main`

After GitHub is connected, make a commit and push to `main`.

Kale Deploy watches the repository default branch, so `main` is the normal path.

### 6. Watch GitHub

On the commit page, look for the Kale Deploy check.

You should see one of these:

- `Live`
- `Needs adaptation for Kale`
- `Unsupported on Kale`

### 7. Open the live app

Live project URLs use this shape:

- `https://<project-name>.cuny.qzz.io`

Example:

- [https://kale-deploy-smoke-test.cuny.qzz.io](https://kale-deploy-smoke-test.cuny.qzz.io)

## What kinds of projects work best

Kale Deploy works best for:

- small websites
- exhibits
- course or project sites
- simple APIs
- forms and guestbooks
- directories, catalogs, and searchable collections
- small interactive apps

Some advanced features may require approval and usage caps:

- chatbots or other AI-backed features
- vector search
- realtime rooms
- very large media collections

It is not a general-purpose server host.

## If you already have a repo

That can still work.

The simplest path is:

1. Open [https://cuny.qzz.io/kale](https://cuny.qzz.io/kale)
2. Use **Check whether a GitHub repo is connected**
3. Enter `owner/repo`
4. Follow the GitHub approval step if Kale Deploy is not connected yet

Your repo still needs to fit the kind of web app Kale can publish.

Good signs:

- it uses TypeScript or JavaScript
- it is already a website or small web app
- it does not depend on a long-running backend server

Warning signs:

- Python backend
- Express or another traditional Node server
- native modules
- local database files
- long-running background jobs

If you are unsure, push the repo and read the GitHub check result. It should tell you whether the project is ready, needs adaptation, or is unsupported.

## If something goes wrong

Start here:

- [troubleshooting.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/troubleshooting.md)
- [support-matrix.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/support-matrix.md)
- [claude-quickstart.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/claude-quickstart.md)
- [codex-quickstart.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/codex-quickstart.md)
