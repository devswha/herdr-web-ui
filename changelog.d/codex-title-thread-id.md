### Fixed
- Codex Chat now finds a session resumed through the `codex resume` picker from another folder
  when Codex shows the thread id in its terminal title: add `"thread-id"` to `[tui].terminal_title`
  in `~/.codex/config.toml`. The title only offers that one conversation: the chat opens it once the
  pane's screen shows one of its answers, as for the pane's own folder. With Codex's default title,
  such a session still shows "Conversation unavailable", since nothing else ties the pane to it.
