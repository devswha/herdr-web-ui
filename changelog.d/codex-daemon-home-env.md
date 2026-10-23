### Fixed
- Native Codex skills on Linux use the first CODEX_HOME or HOME environment value, matching Codex.
  A relative CODEX_HOME is resolved against the Codex process's own directory; when that directory
  cannot be read, scanned skills remain instead of asking a daemon relative to the server.
