### Fixed
- The Windows installer no longer leaves a process behind when a `gh` shim starts a child that keeps
  its output open: `gh` now runs in a job that ends with the call, and its output pipes are closed.
