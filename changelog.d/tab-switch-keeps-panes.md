### Changed
- Switching back to one of the last few tabs shows its terminal and chat at once instead of
  rebuilding them: their panes stay mounted while hidden, let go of the pty, and attach again on
  return.
- A chat opened again draws the conversation it last read straight away and checks for news in
  the background, instead of showing "Loading conversation…" first, and it reads once per
  switch instead of twice.
