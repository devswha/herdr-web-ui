### Fixed
- A connection that went dead without closing (a phone moving from Wi-Fi to cellular, or waking
  after its network changed) no longer leaves the terminal frozen while it still shows connected.
  The app checks the connection when the page comes back, the network changes or nothing arrived
  for 20 seconds, and reconnects within 3 seconds when there is no answer. Keys typed during the
  check are kept as held input instead of being lost.
