// Sahrae sports resolver.
// Loads each live event's player as a TOP-LEVEL page in a stealth headless
// browser (defeats the embeds' anti-framing), captures the live .m3u8 it
// requests, and writes feed.json { updated, events:[{...,streams:[{m3u8,referer}]}] }.
import { writeFileSync } from 'fs';
import puppeteer from 'puppeteer-extra';
import Stealth from 'puppeteer-extra-plugin-stealth';

puppeteer.use(Stealth());

// The stealth plugin can throw async teardown errors (TargetCloseError) when a
// page is closed mid-setup. Swallow stray errors so they never crash the run —
// this is a best-effort scraper and feed.json must still be written.
process.on('unhandledRejection', (e) => console.warn('unhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => console.warn('uncaughtException:', e?.message || e));

const BASES = ['https://streamed.pk', 'https://streamed.su', 'https://streamed.st'];
const MAX_EVENTS = 44;
const CONCURRENCY = 4;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path) {
  for (const base of BASES) {
    try {
      const r = await fetch(base + path, { headers: { 'User-Agent': UA } });
      if (r.ok) return { data: await r.json(), base };
    } catch {}
  }
  return null;
}

async function resolveEmbed(browser, embedUrl) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 720 });
  let found = null;
  page.on('request', (req) => {
    const u = req.url();
    if (!found && /\.m3u8(\?|$)/i.test(u)) {
      found = { m3u8: u, referer: req.headers()['referer'] || embedUrl };
    }
  });
  try {
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const vp = page.viewport() || { width: 1280, height: 720 };
    const cx = vp.width / 2;
    const cy = vp.height / 2;
    // Players often need a tap (sometimes two — to dismiss an overlay, then play).
    await sleep(1500);
    try { await page.mouse.click(cx, cy); } catch {}
    await sleep(1200);
    try { await page.mouse.click(cx, cy); } catch {}
    // Wait up to ~18s for the stream request to appear.
    for (let i = 0; i < 36 && !found; i++) {
      if (i === 14 || i === 26) { try { await page.mouse.click(cx, cy); } catch {} }
      await sleep(500);
    }
  } catch {}
  await page.close().catch(() => {});
  return found;
}

async function main() {
  const liveRes = await getJSON('/api/matches/live');
  const live = liveRes?.data || [];
  const base = liveRes?.base || BASES[0];
  const todayRes = await getJSON('/api/matches/all-today');
  const today = todayRes?.data || [];

  const liveSet = new Set(live.map((m) => m.id));
  // Full schedule (live first, then today), deduped — this is what the app lists.
  const seen = new Set();
  const schedule = [];
  for (const m of [...live, ...today]) {
    if (!m?.id || seen.has(m.id) || !m.sources?.length) continue;
    seen.add(m.id);
    schedule.push(m);
  }

  // Resolve real streams for the LIVE events (only those are actually broadcasting).
  const liveEvents = live.filter((m) => m.sources?.length);
  liveEvents.sort((a, b) => (b.popular ? 1 : 0) - (a.popular ? 1 : 0) || a.date - b.date);
  const toResolve = liveEvents.slice(0, MAX_EVENTS);
  console.log(`schedule: ${schedule.length} events · resolving ${toResolve.length} live from ${base}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--mute-audio'],
  });

  const streamsById = new Map();
  let idx = 0;
  async function worker() {
    while (idx < toResolve.length) {
      const ev = toResolve[idx++];
      const streams = [];
      let attempts = 0;
      for (const src of ev.sources || []) {
        if (attempts >= 3 || streams.length >= 2) break;
        attempts++;
        try {
          const r = await fetch(`${base}/api/stream/${src.source}/${src.id}`, { headers: { 'User-Agent': UA } });
          if (!r.ok) continue;
          const list = await r.json();
          for (const st of (Array.isArray(list) ? list : []).slice(0, 2)) {
            if (streams.length >= 2) break;
            if (!st?.embedUrl) continue;
            const resolved = await resolveEmbed(browser, st.embedUrl);
            if (resolved) {
              streams.push({ label: `${String(src.source).toUpperCase()} ${st.streamNo || ''}`.trim(), m3u8: resolved.m3u8, referer: resolved.referer });
              break;
            }
          }
        } catch {}
      }
      if (streams.length) {
        streamsById.set(ev.id, streams);
        console.log('  ✓', ev.title, `(${streams.length})`);
      } else {
        console.log('  ✗', ev.title);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();

  // Emit the full schedule with streams attached where we resolved them.
  const events = schedule.map((m) => ({
    id: m.id,
    title: m.title,
    category: m.category,
    date: m.date,
    popular: !!m.popular,
    live: liveSet.has(m.id),
    teams: m.teams || null,
    streams: streamsById.get(m.id) || [],
  }));
  events.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || (b.popular ? 1 : 0) - (a.popular ? 1 : 0) || a.date - b.date);

  const withStreams = events.filter((e) => e.streams.length).length;
  writeFileSync('feed.json', JSON.stringify({ updated: Date.now(), base, count: events.length, resolved: withStreams, events }));
  console.log(`done — ${events.length} scheduled, ${withStreams} with live streams`);
}

main().catch((e) => {
  console.error('fatal', e);
  // Still write an (empty) feed so the workflow can commit something.
  try { writeFileSync('feed.json', JSON.stringify({ updated: Date.now(), count: 0, events: [] })); } catch {}
  process.exit(0);
});
