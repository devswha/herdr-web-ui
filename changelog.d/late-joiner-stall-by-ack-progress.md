### Fixed
- A phone on a weak mobile link that opens a busy pane another tab already shows is no longer cut
  off with "Terminal output stopped because this device could not keep up." while it is still
  receiving the pane's recent output, and it no longer freezes that pane's output in the other tab
  meanwhile. A device is now stopped when it has acknowledged nothing for 2 seconds, or has held
  the pane's output paused for 10 seconds. A device joining a busy pane now gets its last 128 KiB
  of output instead of 256 KiB.
