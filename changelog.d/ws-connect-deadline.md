### Fixed
- A connection attempt that hangs (a phone waking on a dead network) is given up after 8 seconds
  and tried again, instead of leaving the app disconnected until reload.
- A page coming back to the screen with a dead connection reconnects at once, even when the
  browser had not yet reported the connection closed.
