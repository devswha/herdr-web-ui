### Fixed
- Two Codex panes in one folder whose answers are short each show their own chat again with Codex
  0.163, which starts a thread in the same second as its process; before, both said the
  conversation was unavailable about as often as not.
- A Codex pane with only short answers still finds its chat after another pane in the same folder
  runs `/new`: a thread that pane shows a long answer of under its first prompt, is bound to, or
  that herdr reports for it no longer leaves this pane unsure.
- Of two Codex panes in one folder with short answers, the one started first finds its chat too
  once the other shows its own first exchange, where it said the conversation was unavailable.
