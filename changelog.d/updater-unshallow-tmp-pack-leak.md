### Fixed
- The updater no longer leaves Git's half-written `tmp_pack_*` files behind when a fetch times
  out or is cancelled, and no longer retries the one-off unshallow fetch every 5 minutes on slow
  links (#1252).
- A failed unshallow fetch now has its leftover `tmp_pack_*` removed also where SIGTERM cannot
  be delivered, like Windows, so the cleanup does not depend on git ending gracefully (#1252).
