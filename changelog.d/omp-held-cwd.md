### Fixed
- An omp pane started with an absolute `--cwd` shows its chat again when herdr names no session
  file: the session is matched against omp's last `--cwd` before `--`, not the pane's directory, and
  a missing value or two omp processes in different directories show no chat rather than a guess. A
  relative `--cwd` still shows none, since omp changes into it and leaves no proof of its base.
