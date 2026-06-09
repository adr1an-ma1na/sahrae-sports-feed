// Sahrae sports feed — lightweight schedule + embed-URL emitter.
//
// Why no server-side .m3u8 resolution any more: streamed's stream tokens are
// IP-LOCKED to whoever resolved them. A URL resolved here (CI datacenter IP)
// returns 403 on the user's phone (different IP) — proven. So instead we publish
// the live schedule + each stream's EMBED URL, and the APP resolves the embed
// → .m3u8 ON-DEVICE, where the token binds to the user's own IP and plays.
//
// Bonus: this needs no headless browser, so the feed is fast and never crashes.
import { writeFileSync } from 'fs';

const BASES = ['https://streamed.pk', 'https://streamed.su', 'https://streamed.st'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SOON_MS = 45 * 60 * 1000;       // also resolve embeds for events starting within 45 min
const STALE_MS = 6 * 60 * 60 * 1000;  // …or that started up to 6h ago (long events still live)
const MAX_RESOLVE = 100;
const MAX_EMBEDS = 6;
const CONCURRENCY = 8;

async function getJSON(path) {
  for (const base of BASES) {
    try {
      const r = await fetch(base + path, { headers: { 'User-Agent': UA } });
      if (r.ok) return { data: await r.json(), base };
    } catch {}
  }
  return null;
}

// Collect the embed URLs (HD first) across all of an event's source servers.
async function embedsFor(base, ev) {
  const out = [];
  const seen = new Set();
  for (const src of ev.sources || []) {
    if (out.length >= MAX_EMBEDS) break;
    try {
      const r = await fetch(`${base}/api/stream/${src.source}/${src.id}`, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const list = await r.json();
      (Array.isArray(list) ? list : [])
        .slice()
        .sort((a, b) => (b?.hd ? 1 : 0) - (a?.hd ? 1 : 0))
        .forEach((s) => {
          if (s?.embedUrl && !seen.has(s.embedUrl) && out.length < MAX_EMBEDS) {
            seen.add(s.embedUrl);
            out.push(s.embedUrl);
          }
        });
    } catch {}
  }
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

async function main() {
  const now = Date.now();
  const liveRes = await getJSON('/api/matches/live');
  const live = liveRes?.data || [];
  const base = liveRes?.base || BASES[0];
  const todayRes = await getJSON('/api/matches/all-today');
  const today = todayRes?.data || [];

  const liveSet = new Set(live.map((m) => m.id));
  const seen = new Set();
  const schedule = [];
  for (const m of [...live, ...today]) {
    if (!m?.id || seen.has(m.id) || !m.sources?.length) continue;
    seen.add(m.id);
    schedule.push(m);
  }

  // Resolve embeds for events that are actually streamable now (live / soon / recently started).
  const resolvable = schedule.filter(
    (m) => liveSet.has(m.id) || (m.date && m.date - now < SOON_MS && now - m.date < STALE_MS)
  );
  resolvable.sort(
    (a, b) =>
      (liveSet.has(b.id) ? 1 : 0) - (liveSet.has(a.id) ? 1 : 0) ||
      (b.popular ? 1 : 0) - (a.popular ? 1 : 0) ||
      a.date - b.date
  );
  const toResolve = resolvable.slice(0, MAX_RESOLVE);
  console.log(`schedule: ${schedule.length} events · collecting embeds for ${toResolve.length} (base ${base})`);

  const embedsById = new Map();
  await pool(toResolve, CONCURRENCY, async (ev) => {
    const e = await embedsFor(base, ev);
    if (e.length) embedsById.set(ev.id, e);
  });

  const events = schedule.map((m) => ({
    id: m.id,
    title: m.title,
    category: m.category,
    date: m.date,
    popular: !!m.popular,
    live: liveSet.has(m.id),
    teams: m.teams || null,
    embeds: embedsById.get(m.id) || [],
  }));
  events.sort(
    (a, b) =>
      (b.live ? 1 : 0) - (a.live ? 1 : 0) ||
      (b.popular ? 1 : 0) - (a.popular ? 1 : 0) ||
      (b.embeds.length ? 1 : 0) - (a.embeds.length ? 1 : 0) ||
      a.date - b.date
  );

  const withEmbeds = events.filter((e) => e.embeds.length).length;
  writeFileSync(
    'feed.json',
    JSON.stringify({ updated: now, base, count: events.length, resolved: withEmbeds, events })
  );
  console.log(`done — ${events.length} scheduled, ${withEmbeds} with embeds`);
}

main().catch((e) => {
  console.error('fatal', e);
  try {
    writeFileSync('feed.json', JSON.stringify({ updated: Date.now(), count: 0, events: [] }));
  } catch {}
  process.exit(0);
});
