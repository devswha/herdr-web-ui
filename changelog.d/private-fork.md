### Changed
- Distribute app releases and remote runtimes from tomrutsaert/herdr-web-ui using fork-only tags.
  App and remote bridge updates require explicit user actions; startup performs no update checks.
- Use token or device pairing for proxied access, with no network identity shortcuts. Configure
  HTTPS reverse proxies or SSH forwarding separately; local loopback access remains available.
- Validate installed and running fork identity before starting or reusing it. Legacy managed bridges
  require explicit approved migration even when their protocol and numeric bundle version match.
- Keep local runtime bundles available from the original source checkout across managed updates.

### Removed
- Maintainer usage counting, its receiver and settings controls, and automatic network discovery
  and publication.
