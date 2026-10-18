### Fixed
- Subscription usage reads OpenCode 2's own credential store before the `auth.json` OpenCode 1
  wrote. OpenCode 2 keeps its provider sign-ins in `opencode.db` and leaves that file standing with
  the key it has since replaced, so the OpenCode card reported "Sign-in expired" for a CLI that was
  signed in and working. The store's active key answers first; the file still answers when the store
  is absent or holds no key of its own.
