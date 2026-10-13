# pulse

A status page on Cloudflare Workers. A cron checks the URLs in `TARGETS` every five minutes, stores each result in
D1, keeps the latest status in KV and serves one HTML page with 24-hour uptime. `/healthz` answers `ok`.

`npm test` runs the tests with Node's built-in runner; there is nothing to install.
