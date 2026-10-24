### Fixed
- Chat messages sent to an omp started with `--session-dir` now wait for its installed herdr
  integration to report readiness, up to the startup timeout (30 seconds), before sending.
