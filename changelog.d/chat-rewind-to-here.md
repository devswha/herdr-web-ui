### Added
- A message in Chat with Claude Code offers Rewind to here while the agent waits and the message box
  is empty: it opens `/rewind` on that message and asks what to restore in a card. After Restore
  conversation the chat drops the turns it went back over at once, and the message comes back in
  the message box, ready to edit and send. Rewinding again waits until that message is sent or
  cleared.
- A message in Chat with grok or Antigravity offers Rewind in terminal: it sends nothing to the
  agent and opens the pane's terminal with a hint to run the agent's own `/rewind` there.
