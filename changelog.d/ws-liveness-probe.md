### Fixed
- A connection that went dead without closing (a phone moving from Wi-Fi to cellular, or waking
  after its network changed) no longer leaves the terminal frozen while it still shows connected.
  The app checks the connection when the page comes back, the network changes or nothing arrived
  for 20 seconds, and reconnects when two checks a few seconds apart get no answer; a slow link
  gets longer each time it is dropped. Keys typed during the check are kept as held input instead
  of being lost, and a message sent during the check waits for the answer instead of failing; it is
  not sent if the page is put away before the answer comes. The key bar comes back as soon as the
  answer does, and a PC on an older version is no longer dropped after a reconnect.
- Once terminal input is held, later typing joins the held input until you send or discard it,
  also after the terminal is ready again: a command is never split between the held text and the
  terminal, and Enter (Ctrl+Enter included), the input line and the message box never run the part
  that already reached it. Backspace edits the held input, and a paste with several lines is
  refused with a note instead of being lost without a word.
