### Changed
- A finished agent you open in the web UI loses its DONE dot in the Agents list and its
  workspace row, as it does in herdr's own client; its next finish shows the dot again. The record
  is kept in each browser, so a finish opened on one device keeps its dot on another.
- A finish behind a drawer, popup viewer, Settings or another dialog keeps its dot, as does a
  hidden zoom target or composer suggestion popup. Crashed panes, loading or failed chats and
  terminals without usable output keep the dot until their content is actually presented. A chat
  scrolled back to older turns keeps it until you return to its end.
- The server identifies finishes after native-agent status overrides and authoritative recovery
  reads, so viewing a working pane does not acknowledge its later finish. Activity order still
  resets obsolete recency counters on older PC bridges.
- Read records are scoped to each PC and server epoch, replaced on server startup or an observed
  herdr restart. Tabs save separate pane keys instead of overwriting a shared roster. Older PC
  bridges without finish identifiers keep their DONE dots until the bridge is updated.
