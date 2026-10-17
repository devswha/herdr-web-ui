### Fixed
- The updater now removes the temporary `tmp_pack_*` files a failed fetch leaves in the
  checkout, ends such a fetch with SIGTERM so that Git releases its lock files, and no longer
  retries a failed history (unshallow) fetch every 5 minutes.
