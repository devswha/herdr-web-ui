### Changed
- Switching tabs is faster. A tab opened for the first time shows its screen in about half the
  time: the bridge paints an attach's screen as soon as herdr draws it instead of holding it
  100 ms, and keeps one terminal sidecar loaded ahead of need. The last eight tabs on a PC, up
  from four, stay ready to show at once.
