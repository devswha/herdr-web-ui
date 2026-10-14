### Removed
- **Move pane to…** in the header's More menu, and `POST /api/pane/move` behind it. Move a pane
  in herdr's TUI; the app follows the roster as before.
- **Send right-clicks to pane** in the pane menu: a right-click on a pane always opens its menu.
- **New tab** in the header's More menu: the tab strip's `+` and the command palette open one.
- **Command palette** in a phone's More menu; an external keyboard still opens it with
  Mod+Shift+K.

### Changed
- The pane header's `⋯` shows only on touch screens; with a mouse, right-click the pane (or press
  Shift+F10) for the same menu.
- The tab's `⋯` on touch screens no longer lists New tab (the strip's `+` sits beside it) or the
  open pane's Split right, Split down and Zoom pane, which change nothing on a phone that shows one
  pane at a time. Right-click menus on a desktop keep them.
