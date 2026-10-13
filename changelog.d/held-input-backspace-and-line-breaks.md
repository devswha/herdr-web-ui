### Fixed
- Input held while the terminal is not ready now follows Backspace, so a deleted character no longer
  comes back. An Enter or a multi-line paste keeps its text with a space where the line break was,
  and the held-input notice says the break was left out instead of dropping the paste in silence;
  Send still never presses Enter.
