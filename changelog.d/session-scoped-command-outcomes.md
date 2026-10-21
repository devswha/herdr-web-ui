### Fixed
- Chat shows only the current agent session's command results: after an agent restarts in the same
  pane, the earlier session's commands no longer appear. A `/clear`, `/new` or resume sent from Chat
  keeps its own row in the conversation it starts, without claiming that it finished. Commands sent
  before an agent's first reply stay with that agent while it keeps running, also through a moment
  in the background (Ctrl+Z); once a different agent takes over the pane, they are hidden, even if
  Chat was not open when it happened. If Chat could not tell which program received such a command,
  it is hidden once the agent's session starts. Outside Linux, an agent restarted under the same
  process number cannot be told apart from the one before it.
