### Fixed
- A new omp session shows its model and reasoning level in the chat's message box before the
  first message, read from omp's status line and matched against the pane's own `omp models`
  catalog; a name that matches no single model is left out rather than guessed.
  Catalog reads use the pane's Linux executable and environment from a neutral directory,
  with a short response budget. Other platforms, explicit overlays and unrecognized status
  layouts leave this model unknown until a transcript exists. Automatically discovered
  providers and project settings that reuse a built-in model name remain a reduced-catalog limitation.
- A Codex started in a terminal shows its model and reasoning level before the first message,
  from Codex's status line, while the chat shows the terminal output.
- Before the first message, a model switched in the terminal shows in the message box once the
  agent draws it.
