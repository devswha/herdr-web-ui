### Fixed
- Chat shows only the current agent session's command outcomes: after an agent restarts in the same
  pane, the earlier session's commands no longer appear. A Chat command that changes the session
  (`/clear`, `/new` or a resume) keeps its own receipt without claiming completion, and commands
  sent before an agent first reports its session ID stay while the agent process recorded at send
  time is still running in that pane. A replacement before the first poll, or under a wrapper that
  keeps the same process group, does not inherit those rows. Linux also checks the agent's process
  start time; outside Linux, a replacement that reuses the same PID cannot be distinguished.
