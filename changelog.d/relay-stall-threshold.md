### Fixed
- A pane on another PC no longer stops for good after a short network stall on a phone: the relay
  now waits for 256 KiB of queued output, like this PC, and reconnects instead of ending the stream.
