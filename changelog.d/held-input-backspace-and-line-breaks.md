### Fixed
- Input held while the terminal is not ready now follows the Backspace key, so text erased with it
  is not sent. An Enter between typed text or a multi-line paste keeps its text with a space where
  the line break was, and the held-input notice says the break was left out instead of dropping the
  paste in silence; Send still never presses Enter. A paste with other control characters is told
  as left out, and an Enter with nothing held no longer leaves a notice.
