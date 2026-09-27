# Development

## Run it

Run the server and Vite side by side:

```bash
bun install
bun run server   # API + WebSocket on :7317
bun run dev      # Vite on :5173, proxies /api and /ws
```

`bun run server` and `bun run dev` never update themselves; only `bun run start` and the plugin run the update supervisor.

## Checks

```bash
bun run typecheck
bun run build
bun test                        # needs herdr installed; creates and removes its own workspaces
bun run test:ui                 # browser regression against isolated test servers
bun scripts/chat-browser-qa.ts  # chat lens end to end
bun scripts/output-browser-qa.ts # terminal output flow control end to end
bun run test:ssh                # remote-PC integration over SSH
bun scripts/fresh-install-docker.ts [owner/repo] [ref]  # a new user's install in a bare Ubuntu (Docker)
```

`fresh-install-docker.ts` is the check for "does a new user get a working install": a disposable
Ubuntu 24.04 with only curl, git and the distro's Node 18, a normal user, herdr and Bun from their
installers, a headless herdr, then `herdr plugin install` of a pushed ref (default: the current
branch), the start action, `/api/health`, the PTY smoke test on the box's Node, and the startup hook
after a herdr restart. It prints the time each step took. `KEEP=1` leaves the container for a look.

Tests run against a herdr session of their own, `herdr-web-ui-test`. The first run starts a headless `herdr --session herdr-web-ui-test server` and later runs reuse it, so test workspaces never show in the herdr you work in (`scripts/test-herdr.ts`). Stop it with `herdr --session herdr-web-ui-test server stop`. `HERDR_TEST_SESSION` picks another name, and `HERDR_TEST_LIVE=1` runs against `HERDR_SOCKET` or your default session instead.

Browser checks look for Chrome at `/opt/google/chrome/chrome`; set `CHROME_PATH` otherwise. After a herdr upgrade, refresh the generated wire types with `bun run generate:types --refresh` (and `--check` to verify).

## README media

`bun run build && bun scripts/readme-media/capture.ts` regenerates the stills and demos in `docs/screenshots/` from a staged, fictional session in its own herdr session (`herdr-web-ui-demo`). Pass `shots` or `video` to redo only one of them. It needs ffmpeg.

- `stage.ts` builds the session: five workspaces under `/tmp/herdr-demo`, curated chats served in place of transcripts, and the hostname rewritten.
- `record.ts` records a walkthrough at 2x (Chrome's screencast, with `--force-device-scale-factor=2`), logging pointer moves, clicks, taps and camera cues as it drives the page.
- `compose.ts` draws every output frame on a canvas: a backdrop, a browser window or a phone, the frame under an eased camera, and a vector cursor with click ripples or touch rings. It writes `demo-*.mp4` (1920×1200 and 1080×1920, 30 fps) and a GIF of each. Stills get the same window or phone on a transparent background.

The MP4s are not committed: GitHub plays a README video only from an upload (`github.com/user-attachments/…`), so drop them into an issue or PR comment and use the link it gives.
The website takes the same two uploads from the README, so a new recording needs only the README links changed.

## Website

<https://devswha.github.io/herdr-web-ui/> is `site/index.html`, a static page. `bun run build:site`
assembles it into `_site/` with the icons, social preview and screenshots it references, the two demo
videos (the local `docs/screenshots/*.mp4` when present, otherwise the README's uploads) and, with
ffmpeg, a poster frame for each video and smaller stills; without ffmpeg the page has no posters.
`.github/workflows/pages.yml` installs ffmpeg, runs the same build and deploys it to GitHub Pages on
every push to `main`.

### The browser demo

<https://devswha.github.io/herdr-web-ui/demo/> is the real client on a fictional session, no server.
`build-site.ts` builds the client a second time with `vite build --base ./` into `_site/demo/app/`,
bundles `site/demo/transport.ts` in front of it and frames it with `site/demo/index.html`. The
transport answers the app's `fetch("/api/…")`, the machines event stream and the `/ws` terminal
socket from `site/demo/fixtures/`: the chats and the Codex approval are the README's
(`site/demo/fixtures.ts`, shared with `scripts/readme-media/stage.ts`), and `machines.json`,
`agents.json`, `commands.json` and the shell pane's `terminal.json` are captured from that staged
session by `bun scripts/demo-fixtures.ts` (needs herdr; it uses the `herdr-web-ui-demo` session and
scrubs the hostname and login). Recapture them after a herdr upgrade changes the snapshot shapes, or
after changing the staged session. Files, images, push and remote PCs are not part of the demo.

## Releasing

1. Open a release PR that bumps `version` in `package.json` and `herdr-plugin.toml`,
   and moves the `Unreleased` notes in [CHANGELOG.md](../CHANGELOG.md) under the new version.
2. Merge it after CI passes.
3. Run **Actions → Release → Run workflow**, select `main`, and enter `X.Y.Z` without `v`.
   The CLI equivalent is `gh workflow run release.yml --ref main -f version=X.Y.Z`.

The workflow validates metadata, then runs the same unit, integration and browser checks
as PRs against the exact `main` commit selected when the run starts. Only after all checks
pass does it create the tag and GitHub release. A failed validation creates neither.
Do not push release tags by hand: installed updaters read Git tags directly, so a tag is
visible to them even without a GitHub release. Existing tags cannot be reused; fix a
published version with a new patch release. If publishing fails after a tag was created,
verify that tag's commit and repair its GitHub release rather than moving the tag.

Remote-PC runtime bundles are released separately: raise `REMOTE_BUNDLE_VERSION` in `shared/machines.ts` and push a `remote-vN` tag. See [remote PCs](remote-pcs.md).

## Pull requests and CI

Use short-lived `feat/*`, `fix/*` or `chore/*` branches from `main`. Keep each PR focused
on one change, squash merge it after required checks pass, and delete its remote branch
after merging. Remove local branches/worktrees only when their work is finished.
There is no permanent `develop` branch. Release metadata changes also go through a PR.

The [CI workflow](../.github/workflows/ci.yml) runs on every PR and `main` push:

- **Fast checks**: frozen dependency install, generated type freshness, typecheck, build,
  and `bun run test:unit`. This suite does not start herdr.
- **Integration and browser**: checksum-pinned herdr 0.9.1, Node 22, isolated state/session,
  `bun run test:integration`, and `scripts/ui-regression.ts` with the lockfile's Chromium.
  Missing herdr fails the integration suite. The owned session is stopped even on failure.
  Integration tests have a 15-second default timeout so their bounded process-startup
  probes can finish; individual tests can still specify a longer timeout.

`scripts/ci-tests.ts` discovers all `.test.ts` files under src/shared/server/scripts.
Files named `*.contract.test.ts`, tests under `server/herdr/` and `server/pty/`, and
`server/updater.test.ts` (which includes real bridge restart/rollback cases) belong
to integration; everything else belongs to unit. Name new live-server tests
`*.contract.test.ts`. Plain `bun test` still runs both suites for local development.

Remote/server/shared/dependency changes also run the existing four-platform bundle and
SSH workflow on PRs; its publishing job only runs for `remote-v*` tags. Website publishing
continues after `main` pushes.

Repository protection should require PRs and both CI checks on `main`, including for
administrators, with branches up to date before merging. Force pushes and branch deletion
are disabled. Human approvals are optional for this maintainer-led project; external
contributions still need maintainer review. CodeRabbit is advisory, not a required check.
Release tags must not be moved or deleted. These GitHub settings are separate from files
in the checkout.

The [CodeRabbit configuration](../.coderabbit.yaml) reviews non-draft PRs, reads the committed
[review guidelines](../.github/REVIEW.md) and any available AGENTS.md,
and focuses on protocol, permissions and terminal lifecycle regressions. Generated output
and media are excluded. Enable the [CodeRabbit GitHub App](https://github.com/apps/coderabbitai)
for this repository to activate it; the YAML alone does not install the app. Reassess
useful findings versus false positives after two weeks. Keep final merge decisions with
the maintainer.

## Layout

| Path | Contents |
| --- | --- |
| [`src/`](../src/) | React UI: chat, terminal, composer, sidebar, settings |
| [`server/`](../server/) | API, WebSockets, transcript readers, push, PTY bridge, remote PCs and updater |
| [`shared/`](../shared/) | HTTP/WebSocket contract and generated herdr types |
| [`scripts/`](../scripts/) | Plugin lifecycle, type generation, remote bundles, README media and browser checks |
| [`public/`](../public/) | PWA manifest, service worker and icons |
| [`docs/`](.) | Remote PCs, updates, flow control, chat audit and brand assets |
| [`site/`](../site/) | The website, built by `scripts/build-site.ts` and deployed by GitHub Pages |
| [`DESIGN.md`](../DESIGN.md) | Design tokens and UI conventions |
