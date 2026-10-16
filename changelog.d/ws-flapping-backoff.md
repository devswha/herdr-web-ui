### Fixed
- A connection that opens and drops again no longer retries every quarter second: retries back off
  until it has stayed open for 10 seconds. Returning to the page still retries immediately.
