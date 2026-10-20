### Added
- Reverse proxies can probe `/health` without signing in: GET returns plain-text `ok`, and
  HEAD returns the same status without a body. The deployment guide documents `HOST=0.0.0.0`
  for gateways that connect from another machine.
