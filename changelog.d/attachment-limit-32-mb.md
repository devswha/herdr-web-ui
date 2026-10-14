### Changed
- A file up to 32 MB can be attached in the composer (it was 8 MB).

### Fixed
- A file over the attachment limit, however large, is refused with the size message; a very large
  upload no longer ends in a blank 413 the browser cannot explain.
