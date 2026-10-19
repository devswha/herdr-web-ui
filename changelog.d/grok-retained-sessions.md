### Fixed
- Grok chat remains available with older session files open when Herdr's reported session
  holds its `events.jsonl` in exactly one directory and that file was written more recently
  than every other held session's events file. Missing files, duplicate held IDs and tied
  write times use Terminal. The newest file only confirms Herdr's ID, never selects another;
  an in-TUI `/resume` that writes to an unreported session shows Terminal until Herdr names it.
