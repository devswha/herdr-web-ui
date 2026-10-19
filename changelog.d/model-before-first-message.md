### Fixed
- A Codex started in a terminal shows its model and reasoning level before the first message,
  from Codex's live footer or its model picker's current-model option, while the chat shows the
  terminal output. Ordinary text beneath the banner cannot supply the model.
- Before the first message, a model switched in the terminal shows in the message box once the
  supported agent draws it. omp still waits for its transcript to record the model; the bridge
  never runs `omp models`, which can refresh the CLI's OAuth credentials.
