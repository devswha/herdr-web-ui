# Manual app updates

The managed launcher and plugin offer **Check for updates** and **Update and restart** in
Settings → About. Neither startup nor a timer fetches releases or installs updates.
`bun run server` remains unmanaged. Reloading the frontend is explicit, preserving drafts.

## Distribution contract

`shared/distribution.ts` owns the TypeScript distribution identity: `tomrutsaert/herdr-web-ui`,
app tags `fork-vX.Y.Z`, and runtime tags `fork-remote-vN`. Standalone installers and workflows
mirror this contract. The plugin ID stays `devswha.herdr-web-ui` for existing state. Managed update state is
distribution-scoped so an inherited upstream build is never resumed; device and push state stay.
The updater fetches the fixed fork HTTPS Git URL, never a retargeted `origin`. It fetches app
tags into a dedicated ref namespace, pruning removed tags, and ignores inherited upstream tags
and pre-releases. Tests rewrite that fixed Git URL to temporary local repositories using
repository-local Git configuration; no production environment override is provided.

## Deployment and recovery

- `server/managed.ts` launches the active supervisor. `server/supervisor.ts` owns bridge startup,
  IPC commands and health-checked rollback. `server/updater.ts` owns bounded Git and build work.
- A clean `main` source checkout or a managed plugin checkout is required. Revision and ancestry
  guards refuse unrelated histories or local changes. The source worktree is never rewritten.
- Installation builds the exact selected commit in a separate directory with frozen dependencies,
  typechecking and a frontend build. A fresh boot ID must pass health before persistence.
  Failure restores the previous build. Herdr and agents are not updated or stopped by this path.
- After success the launcher hands over to the new supervisor, falling back if it fails to start.
  The two latest successful builds are retained. Update state is separate from push credentials.
- Notes are read from the offered commit's changelog and localized release summaries, not main.
  The running release records the replaced version and time for installed notes.
- Status polling is local IPC/HTTP, not release discovery. If a checkout was rebuilt under a
  running server, `served_revision` asks the user to restart rather than reload onto stale code.
- Remote bridge upgrades require **Update bridge** for each PC; reconnect never approves one.

## Verification seams

`server/updater.test.ts` uses temporary Git remotes, isolated builds and stand-in commands for
selection, manual installation, source guards, cleanup, cancellation and rollback. Its managed
bridge cases run through the isolated repository checker. `server/api.contract.test.ts` covers
update authorization and origin guards. `scripts/update-browser-qa.ts` exercises explicit
Check/Update, release notes, reload, draft preservation and failed-boot recovery with an isolated
session and local Git remote. Never run these against a user's session or real release service.
