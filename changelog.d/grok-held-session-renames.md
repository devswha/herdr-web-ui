### Fixed
- Grok chat falls back to the terminal, instead of showing an older conversation, when Grok holds
  a session's events file under another name: renamed to `old-events.jsonl`, or in a session
  folder renamed to a name the session filter skips.
