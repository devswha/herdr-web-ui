### Fixed
- When the source checkout a managed server runs from is replaced under it (`herdr plugin install`
  run again, or `git pull` and a build), the app now tells you to restart herdr web ui on the PC
  instead of showing "App updated" and **Reload app**, which never went away because a reload
  loaded the same build again. The notice shows after the next update check (up to 5 minutes, or
  **Check for updates**) and goes away once the server restarts.
