### Fixed
- When the app's server cannot reach herdr, the sidebar's connection error and the header's
  "herdr offline" pill now say what to do: start herdr on this PC, or check HERDR_SOCKET.
- A setting the server cannot save (its state folder is read-only) no longer fails silently:
  Settings shows a plain sentence with the next step, the server's own words behind Details, and
  the change is sent again once the folder can be written.
