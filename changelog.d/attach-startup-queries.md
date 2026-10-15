### Fixed
- With herdr 0.9.4 or later, opening a terminal on a second device no longer types stray
  characters such as `1016;2$y1;2c` into the pane: the app answers herdr's attach-time terminal
  queries itself instead of replaying them to every browser.
