### Fixed
- A tab left open across an update no longer stores the app's page under a script's address:
  a file the server no longer has answers 404, the offline cache is kept per build instead of
  growing with every release (typefaces and icons stay cached across updates, and an update
  keeps the files the new page starts with), and math or a diagram that failed to load brings
  up a "Reload app" line at once.
