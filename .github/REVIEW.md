# Review priorities

Report concrete failing scenarios and regressions before style suggestions. A passing
AI review is advisory; CI and maintainer review determine whether a PR can merge.

- This app bridges herdr-owned PTYs. Never use `--takeover`, load node-pty in Bun,
  or rebuild terminal output from viewport snapshots. Keep xterm scrollback at zero.
- Observe connections cannot input, send keys or resize. Enforce this on the server.
- Never queue terminal input across disconnections. Only control frames replay.
- Concurrent attaches share pending creation; detach/close during creation must cancel
  that client's claim. Release the sidecar after its last client leaves.
- Each herdr RPC needs a fresh socket; only subscriptions stay connected. Pass the
  same socket to terminal attach through `HERDR_SOCKET_PATH`.
- Tests mutate only panes they create and use temporary app state. UI/media captures
  use isolated test/demo sessions. Preserve the user's running terminals and push keys.
- Generate `shared/herdr-api.generated.ts` from the committed schema. Check changes
  to HTTP/WS contracts on both client and server and cover them with contract tests.
- A malformed VAPID file must fail without rotating the key. The service worker must
  show a notification for every push, including while the app is visible.
- Preserve IME and native clipboard input. Use existing theme tokens for component CSS.
- Installed updaters discover Git tags immediately. Release only the exact commit
  that passed CI; never create the release tag as a prerequisite for validation.

Additional local AGENTS.md instructions may exist in a developer checkout. The rules
above are committed so remote reviewers receive the essential project constraints.
