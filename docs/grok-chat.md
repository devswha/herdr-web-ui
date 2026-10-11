# Grok chat

The reader shows Grok's user messages, assistant text and expandable tool rows in
the existing Chat view. Terminal remains the place for approvals. Reading chat makes no
model calls. Reasoning, images and child-session expansion are outside this first scope.

Native lifecycle checks used Grok 1.0.50 and Herdr 0.9.3 on Linux. macOS and Windows
implementations are included but have not been run on those operating systems. Reports
of platform-specific failures are welcome for follow-up fixes. No installer changes the
Grok configuration.

## Finding the active session

On Linux the bridge reads the foreground Grok process's environment for `GROK_HOME`,
or `HOME/.grok` when unset. On macOS and Windows the helper below supplies the store
from its inherited environment and native transcript path. Windows also accepts
`USERPROFILE` when `HOME` is absent. Process discovery uses Herdr's foreground list
on Unix and the existing Windows process-table reader under the pane's shell on Windows.
A reported ID is looked up exactly, including hashed directory names for long paths;
directory or modification time never chooses a conversation.

Grok 1.0.50 does not fire `SessionStart` on an in-TUI `/resume`. Herdr can therefore keep
an old ID. `active_sessions.json` and open file descriptors can contain multiple sessions;
neither identifies which of them is on screen. Without the helper below, chat is available
only on the tested native executable `grok-1.0.50-linux-x86_64` when its sole held
`events.jsonl` session agrees with Herdr. Ambiguity uses the terminal fallback. Other builds
require the helper; this restriction is deliberate, not proof that their files differ.

## Optional session refresh helper

Grok's command status line supplies the active `session_id` and `transcript_path`, including
after an idle `/resume`. `scripts/grok-statusline.ts` forwards that ID to the pane's explicit
Herdr socket and writes a small process-bound observation for the reader. It records no
message content or credentials. The observation must match Herdr's ID, the process's PID,
process-start identity and its actual store, and must be at most 15 seconds old.

**Compatibility workaround:** Herdr 0.9.3 accepts a changed Grok ID only with a newer
sequence and `session_start_source: "new"`. The helper uses that value for resume too.
This is not a truthful new-session event; a documented Herdr switch/refresh operation should
replace it. The helper checks the resulting pane ID because an ignored report still answers
`ok`. A failure leaves chat unavailable rather than selecting another transcript.

Requirements: Bun 1.4+ and Grok running inside Herdr. On Windows, process discovery
uses PowerShell, as the existing agent readers do. All paths must be on the machine
that runs Grok and the bridge. macOS/Windows, remote-host and dashboard/background-view
behavior have not been natively verified. The helper uses Bun's built-in SQLite for
exclusive reporting; it does not require `flock`.

Build a standalone helper from the reviewed checkout into a **stable location you own**.
Do not point Grok at an updater's versioned release directory. For example, after choosing
the destination and reviewing the configuration change:

```sh
mkdir -p "$HOME/.local/share/herdr-web-ui"
bun build scripts/grok-statusline.ts --target=bun \
  --outfile "$HOME/.local/share/herdr-web-ui/grok-statusline.js"
command -v bun
```

The commands above use a POSIX shell. On Windows, build with the same Bun command
and choose an absolute destination in your user profile; `(Get-Command bun).Source`
prints the Bun executable path in PowerShell.

Use that absolute Bun path and absolute bundle path in the Grok home belonging to the pane:

```toml
[ui.status_line]
type = "command"
command = "/absolute/path/to/bun /absolute/path/to/grok-statusline.js"
refresh_interval = 5
```

`refresh_interval = 5` (or a smaller positive value) is required. Without it an idle binding
expires after 15 seconds. Grok reads this setting at its next launch; this document does not
ask you to restart a running session. Rebuild the bundle deliberately when updating the
adapter; observation format version 1 is checked on both sides.

Grok has only one status-line command. Preserve an existing command by chaining it:

```toml
command = "/absolute/path/to/bun /absolute/path/to/grok-statusline.js -- /bin/sh -c 'YOUR EXISTING COMMAND'"
refresh_interval = 5
```

The chaining example uses a POSIX shell. On Windows, pass the existing command
and arguments after `--` using its Windows shell. Quote the existing command correctly
for both TOML and the shell; the placeholder is not
an install command. The wrapper passes stdin bytes and stdout through and preserves the
command's exit code. If the reporter cannot run, it does not fail the existing status row.
Oversized payloads still reach the original command and simply skip reporting. Reporting
has a one-second reporting budget on Unix and five seconds on Windows (for process-table
queries), serialized writes and a five-second retry backoff.
A report acknowledgement timeout still permits a read-only check of the resulting pane
identity within that budget; it does not resend the update.

Switches are asynchronous: an isolated native test of this bundled helper took about
4.3 seconds from resume selection to corrected Herdr identity and matching Chat, without
a new model call. The old chat can remain briefly before the report arrives. A repeated
session or failed attempt can wait for the next five-second refresh. A late hook may temporarily
restore an old ID; the reader requires equality and the next heartbeat corrects it.
Welcome screens and hidden status-line views emit no fresh observation. An identified idle
session with an existing readable file can show empty chat; a missing file is not treated as
proof of an empty conversation.

Observations live in a `grok-chat` directory beside the pane's Herdr socket (the
socket marker on Windows). Both sides find the same directory without guessing a
Grok home. Filenames hash the canonical socket path and pane ID. On Unix the
directory is 0700 and files are 0600; Windows uses the containing user's Herdr
directory permissions. `.json` is the accepted observation, `.json.attempt` throttles
failed reporting, and `.json.lock` is a SQLite database used only for locking.
They contain local paths/IDs, not transcripts. They currently remain until removed.
To uninstall, restore the previous status-line setting and, once the helper is no longer
running, remove its observation directory and standalone bundle. An expired observation
intentionally blocks fallback until a fresh helper report or removal; it is not silently
replaced by a stale hook report.

## History and limits

The adapter reuses the shared transcript pager and response contract. It applies rewind
markers in file order before paging; a marker changes history identity even before a new
prompt arrives. Old cursors return 409. Compaction records do not discard displayed turns.
Hidden prompts still separate turns; `syntheticPrompt` alone does not hide a message.

Tool updates replace present fields and preserve omitted fields. Native tool names come
from `_meta["x.ai/tool"].name` when ACP `name` is absent. Diffs are retained separately when
later content replaces them. Long output references include store, session/history, call
and output revision, so expanded output cannot remain pinned to an earlier result.
Terminal-reference blocks are shown as references; their separate ACP output is not fetched.

Reads scan at most 32 MiB per catch-up, in bounded chunks, and keep at most 100,000 indexed
prompts/tools per file and 16 indexes. Lines over 16 MiB and unreconstructable history use
the terminal fallback. Newest pages use the shared 16 MiB window; older pages can widen to
64 MiB. A mid-turn page missing its tool-call seed, an unknown/abandoned/earlier-owner update,
or a malformed history-control record is unavailable rather than silently misrepresented.

## Verification

```sh
HERDR_TEST_MODE=unit bun test ./server/grok.test.ts ./scripts/grok-statusline.test.ts
bun run check run bun test ./server/api.contract.test.ts --test-name-pattern 'Grok conversation API'
bun run check run --build bun scripts/grok-chat-browser-qa.ts
bun run check fast
```

The contract test uses an isolated real Herdr and disposable Grok-shaped fixture processes;
it verifies the actual reporter and HTTP identity/cursor behavior, not the native TUI.
Before the cross-platform helper refactor, a separate isolated real Grok TUI test verified the helper across `/new` and
idle `/resume`, with the actual hook and a fixture model; the model-call count did not
increase during resume. Native fictional captures separately establish replay equivalence
after nested rewinds.
The browser test runs the real built client against fictional files and checks retained
expanded output after updates, shrink and rewind. It never opens the user's browser session.
Native tool writes are also captured from a fictional printf call. Dashboard/background
switching, forks and broader platform coverage remain release-validation work; synthetic fixtures do not establish those behaviors.
