### Fixed
- The updater no longer leaves Git's half-written `tmp_pack_*` files behind when a fetch times
  out or is cancelled, and no longer retries the one-off unshallow fetch every 5 minutes on slow
  links (#1252).
