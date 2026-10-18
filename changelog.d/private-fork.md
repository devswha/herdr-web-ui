### Changed
- Publish app releases from tomrutsaert/herdr-web-ui using fork-only app tags. Operators deploy
  software updates separately; application startup never discovers or installs updates.
- Use token or device pairing for proxied access, with no network identity shortcuts. Configure
  HTTPS reverse proxies or SSH forwarding separately; local loopback access remains available.
- Validate installed and running fork identity before starting or reusing the web plugin.
  Migrations preserve the plugin configuration and application state.

### Removed
- Maintainer usage counting, its receiver and settings controls, and automatic network discovery
  and publication.
