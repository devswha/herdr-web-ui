### Fixed
- GJC chats no longer fall back to the terminal text after a busy spell: a timed-out GJC session
  lookup is now ended with SIGTERM instead of SIGKILL, which left GJC lock files behind that
  slowed every later lookup until no running GJC session read as live.
