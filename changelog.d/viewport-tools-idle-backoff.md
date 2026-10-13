### Fixed
- A terminal pane left open and quiet no longer asks herdr for its scroll position every second:
  the scrollbar's poll backs off to every 15 seconds and speeds up again on output, scrolling,
  resizing or returning to the tab. Each drawn frame also no longer measures the page layout
  unless a search has highlights to place, which saves battery on phones.
