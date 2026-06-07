# sahrae-sports-feed

Auto-updating live sports feed for the Sahrae Entertainment app.

A scheduled GitHub Action runs `resolve.mjs` every 15 minutes: it loads each
live event's player in a stealth headless browser, captures the live `.m3u8`,
and writes `feed.json`. The app reads the public `feed.json` and plays the
streams through its native HLS proxy.

Feed URL: `https://raw.githubusercontent.com/adr1an-ma1na/sahrae-sports-feed/main/feed.json`
