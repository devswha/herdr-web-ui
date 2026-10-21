### Fixed
- Chat shows only the current agent session's command outcomes: after an agent restarts in the same
  pane, the earlier session's commands no longer appear. A Chat command that changes the session
  (`/clear`, `/new` or a resume) keeps its own receipt without claiming completion, and commands
  sent before an agent first reports its session ID stay unless another process took its place.
