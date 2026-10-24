### Fixed
- Each plugin start keeps the run before it as `server.log.1` and begins a new `server.log`,
  instead of appending every run to one file that grows forever. While the recorded server is
  still running, the start appends to its log as before.
- A failed plugin start reads at most the last 64 KiB of what its server wrote to `server.log`
  for the lines it prints, so a large log no longer costs memory. On Windows, the plugin's
  wrapper still shows the last 15 lines of `server.log` itself.
