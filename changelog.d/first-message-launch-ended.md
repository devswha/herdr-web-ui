### Fixed
- A first message from New workspace or New tab no longer waits forever when the agent started for
  it quits before the message goes: it is held for Send now or Discard. The same happens when an
  agent of the same kind that the user starts later comes up instead, and when the page that sent it
  leaves the pane while it is being typed, so the pane's other queued messages are not stuck behind it.
