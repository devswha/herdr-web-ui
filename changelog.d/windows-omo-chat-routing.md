### Fixed
- On Windows, OmO chat follows the pane's process tree and native session owner instead of the shell label.
- Verify Windows process identities and ancestor start times before routing a pane, keep sidebar refreshes off the PowerShell wait, and reuse command discovery within a request.
- Keep foreground Pi separate from background OmO processes, share Windows discovery for five seconds without probing other agents, and retain the sidebar label during a bounded background refresh.
