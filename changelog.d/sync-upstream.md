### Fixed
- Plugin configuration can explicitly select a herdr session with `HERDR_SOCKET`, overriding the
  session that launches it. Server startup errors explain address and port binding failures, and
  an offline herdr connection shows a hint to start herdr or check `HERDR_SOCKET`.
- Settings show save failures while retrying. Files follows pane switches, and prompt cards stay
  visible when a prompt read fails.
- Touch-terminal input keeps the caret after its repeat-key placeholder when composing text.
### Maintenance
- Integrate upstream server connection, status and input refactors while retaining the fork's
  single-workstation deployment model.
