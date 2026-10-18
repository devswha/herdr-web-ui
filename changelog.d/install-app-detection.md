### Fixed
- Install app no longer shows inside an installed app's window, in any display mode, nor in a
  Chrome or Edge 140+ tab of an address whose app is installed.

### Added
- The installers open the app in your browser after a new install on a PC with a desktop, where
  the address bar's Install adds it. Over SSH they print the `ssh -L` tunnel to run instead, and
  `HERDR_WEB_NO_OPEN=1` turns the opening off.
- The fork website shows Windows visitors the fork PowerShell installer and copies its command.
