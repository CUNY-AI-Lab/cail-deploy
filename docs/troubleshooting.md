# Troubleshooting

This page covers the most common problems when using Kale Deploy.

## I installed the GitHub App and nothing happened

Check these first:

- the app is installed on the correct repository
- the installation covers that repo, not just a different one
- you pushed to the repository default branch
- the default branch is `main` or the branch GitHub lists as default

If there is no check run at all, the webhook probably never fired for that repo or branch.

## The GitHub App install flow feels like a loop

The setup may still have worked even if GitHub returns you to what looks like the same page.

First, check the Kale setup page again for that repository. It should say whether GitHub is connected.

If it is still unclear, verify it from GitHub:

1. Open GitHub settings for installed apps.
2. Open `CAIL Deploy`.
3. Check whether your repository is included.

If it is included, the install succeeded.

## The check run says “Needs adaptation for Kale”

This means the repo is close, but not yet in the supported Worker shape.

Common reasons:

- missing `wrangler.jsonc`
- missing Worker entrypoint
- traditional Node server structure
- filesystem assumptions

Best fix:

- scaffold a fresh project with `kale-init`
- choose `--shape static` for a pure publishing site or `--shape worker` for forms, APIs, or other request-time behavior
- move your app logic into that structure

## The check run says “Unsupported on Kale”

This means the repo is outside the supported runtime.

Common reasons:

- Python project
- native modules
- container-style server workload
- traditional backend that depends on a long-running process

The right move is usually to rebuild the deployable part as either a pure static Kale site or a Worker app rather than trying to force the original stack onto Kale Deploy.

## My app deployed but the page is broken

Check:

- browser dev tools for missing assets or broken API requests
- whether the app expects a different runtime than Workers
- whether the app assumes local disk or process state

Because live apps now use host-based URLs like `https://<project>.cuny.qzz.io`, most normal asset paths should work as expected. If the app is still broken, the issue is usually in the project code, not the URL prefix.

## The project URL does not load

Check:

- whether the GitHub check finished successfully
- whether the project name in the URL matches the deployed slug exactly
- whether the repo had a successful latest deployment

Example URL shape:

- `https://my-project.cuny.qzz.io`

## The build failed during dependency install

Common reasons:

- broken lockfile
- incompatible package manager setup
- package expects a different runtime
- native module install

Try:

- run the install locally
- run the build locally
- simplify the dependency set
- replace Node-only packages with Worker-compatible ones

## The build succeeded but runtime behavior is wrong

That usually means the repo can bundle, but the app logic still assumes a traditional server model.

Watch for:

- `app.listen(...)`
- filesystem writes
- in-memory sessions
- socket assumptions
- packages expecting full Node APIs

## The app works locally in Node but not on Kale Deploy

That is possible because local Node and Cloudflare Workers are different runtimes.

Local success in Node does not prove Worker compatibility.

Use local Worker-style testing where possible:

```bash
npm run check
npx wrangler dev
```

## I do not know whether my project is a good fit

Read:

- [support-matrix.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/support-matrix.md)
- [quickstart-students.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/quickstart-students.md)

If you are still unsure, the safest path is:

1. start with `kale-init`
2. choose `--shape static` or `--shape worker` explicitly
3. move your content and logic into that structure
4. keep the project small until deployment works
