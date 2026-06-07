#!/usr/bin/env python3
"""
DaddyLive (DLHD) resolver — full live-sports coverage.

Replicates the current DaddyLive stream-resolution flow (as used by the
maintained StepDaddyLiveHD project), using curl_cffi to impersonate Chrome's
TLS so it passes Cloudflare without a browser. Pure HTTP = fast, so we can
resolve the whole day's schedule. Writes feed.json that the Sahrae app reads
and plays through its native HLS proxy (which supplies the Referer the
newkso.ru CDN requires).
"""
import asyncio
import base64
import json
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

from curl_cffi.requests import AsyncSession

BASES = ["https://dlhd.dad", "https://daddylive.dad", "https://thedaddy.to"]
UA = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0"
MAX_CHANNELS = 220
CONCURRENCY = 12

SPORT_MAP = {
    "soccer": "football", "football": "football", "fußball": "football",
    "tennis": "tennis", "basketball": "basketball", "baseball": "baseball",
    "ice hockey": "hockey", "hockey": "hockey", "motorsport": "motor-sports",
    "motor sports": "motor-sports", "am. football": "american-football",
    "american football": "american-football", "cricket": "cricket",
    "golf": "golf", "rugby union": "rugby", "rugby league": "rugby", "rugby": "rugby",
    "fight": "fight", "boxing": "fight", "mma": "fight", "wwe": "fight", "darts": "darts",
}


def norm_category(cat: str) -> str:
    c = (cat or "").strip().lower()
    for k, v in SPORT_MAP.items():
        if k in c:
            return v
    return "other"


def headers(referer: str, origin: str = None):
    h = {"Referer": referer, "user-agent": UA}
    if origin:
        h["Origin"] = origin
    return h


def decode_bundle(text: str) -> dict:
    cands = set()
    cands.update(re.findall(r'JSON\.parse\s*\(\s*atob\s*\(\s*["\']([^"\']{40,})["\']\s*\)\s*\)', text))
    cands.update(re.findall(r'atob\s*\(\s*["\'](eyJ[A-Za-z0-9+/=]{40,})["\']\s*\)', text))
    cands.update(re.findall(r'(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*["\'](eyJ[A-Za-z0-9+/=]{40,})["\']', text))
    cands.update(re.findall(r'["\'](eyJ[A-Za-z0-9+/=]{40,})["\']', text))
    cands.update(re.findall(r'["\']([A-Za-z0-9+/=]{80,})["\']', text))
    for cand in cands:
        try:
            data = json.loads(base64.b64decode(cand).decode("utf-8"))
            if not all(k in data for k in ["b_ts", "b_sig", "b_rnd", "b_host"]):
                continue
            out = {}
            for k, v in data.items():
                if isinstance(v, str):
                    try:
                        out[k] = base64.b64decode(v + "=" * (-len(v) % 4)).decode("utf-8")
                    except Exception:
                        out[k] = v
                else:
                    out[k] = v
            return out
        except Exception:
            continue
    return {}


async def resolve_channel(session: AsyncSession, base: str, channel_id: str):
    try:
        stream_page = f"{base}/stream/stream-{channel_id}.php"
        r1 = await session.get(stream_page, headers=headers(base), timeout=20)
        m = re.findall(r'iframe src="(.*?)"\s*width', r1.text)
        if not m:
            return None
        source_url = m[0]
        r2 = await session.get(source_url, headers=headers(stream_page), timeout=20)
        keys = re.findall(r'const\s+CHANNEL_KEY\s*=\s*"(.*?)";', r2.text)
        if not keys:
            return None
        channel_key = keys[-1]
        data = decode_bundle(r2.text)
        if not all(k in data for k in ["b_ts", "b_sig", "b_rnd", "b_host"]):
            return None
        auth_url = f"{data['b_host']}auth.php?channel_id={channel_key}&ts={data['b_ts']}&rnd={data['b_rnd']}&sig={data['b_sig']}"
        ar = await session.get(auth_url, headers=headers(source_url), timeout=20)
        if ar.status_code != 200:
            return None
        pu = urlparse(source_url)
        lookup = f"{pu.scheme}://{pu.netloc}/server_lookup.php?channel_id={channel_key}"
        lr = await session.get(lookup, headers=headers(source_url), timeout=20)
        server_key = lr.json().get("server_key")
        if not server_key:
            return None
        if server_key == "top1/cdn":
            m3u8 = f"https://top1.newkso.ru/top1/cdn/{channel_key}/mono.m3u8"
        else:
            m3u8 = f"https://{server_key}new.newkso.ru/{server_key}/{channel_key}/mono.m3u8"
        return {"m3u8": m3u8, "referer": source_url}
    except Exception:
        return None


def parse_time(date_key: str, hhmm: str) -> int:
    # date_key like "Sunday 7th June 2026 - Schedule Time UK GMT"; treat time as today UTC.
    try:
        h, mm = hhmm.split(":")
        now = datetime.now(timezone.utc)
        dt = now.replace(hour=int(h), minute=int(mm), second=0, microsecond=0)
        return int(dt.timestamp() * 1000)
    except Exception:
        return int(time.time() * 1000)


async def main():
    session = AsyncSession(impersonate="chrome")

    # Schedule from the reachable cache CDN (works from any IP).
    schedule = None
    try:
        r = await session.get("https://daddylive.eu/cache/tv/tv.json", headers=headers("https://daddylive.eu/"), timeout=25)
        print(f"schedule (daddylive.eu): {r.status_code}")
        if r.status_code == 200:
            schedule = r.json()
    except Exception as e:
        print("schedule error:", type(e).__name__, e)

    # Probe which resolution domain is reachable (these sit behind Cloudflare).
    base = None
    for b in BASES:
        try:
            pr = await session.get(f"{b}/", headers=headers(b), timeout=18)
            txt = (pr.text or "")[:200].lower()
            cf = "cloudflare" in txt or "just a moment" in txt or "challenge" in txt
            print(f"probe {b}: {pr.status_code}{' [cloudflare-challenge]' if cf else ''}")
            if pr.status_code == 200 and not cf:
                base = b
                break
        except Exception as e:
            print(f"probe {b}: ERR {type(e).__name__}")
    if base is None:
        base = BASES[0]
    print(f"resolution base: {base}")

    if not schedule:
        with open("feed.json", "w") as f:
            json.dump({"updated": int(time.time() * 1000), "count": 0, "resolved": 0, "events": []}, f)
        print("no schedule reachable")
        return
    print(f"schedule from {base}")

    # Flatten events; collect (event, [(channel_id, channel_name)]).
    raw_events = []
    for date_key, cats in schedule.items():
        for cat, evs in cats.items():
            if not isinstance(evs, list):
                continue
            for ev in evs:
                chans = (ev.get("channels") or []) + (ev.get("channels2") or [])
                chans = [(str(c.get("channel_id")), c.get("channel_name", "")) for c in chans if c.get("channel_id")]
                if not chans:
                    continue
                raw_events.append({
                    "title": ev.get("event", "").strip(),
                    "category": norm_category(cat),
                    "date": parse_time(date_key, ev.get("time", "")),
                    "channels": chans[:3],
                })

    # Unique channels to resolve (dedup; many events share a channel).
    uniq = {}
    for ev in raw_events:
        for cid, name in ev["channels"]:
            uniq.setdefault(cid, name)
    channel_ids = list(uniq.keys())[:MAX_CHANNELS]
    print(f"{len(raw_events)} events · resolving {len(channel_ids)} unique channels")

    resolved = {}
    sem = asyncio.Semaphore(CONCURRENCY)

    async def worker(cid):
        async with sem:
            res = await resolve_channel(session, base, cid)
            if res:
                resolved[cid] = res

    await asyncio.gather(*[worker(c) for c in channel_ids])
    print(f"resolved {len(resolved)}/{len(channel_ids)} channels")

    now = int(time.time() * 1000)
    out = []
    for i, ev in enumerate(raw_events):
        streams = []
        for cid, name in ev["channels"]:
            r = resolved.get(cid)
            if r:
                streams.append({"label": name or f"Server {len(streams)+1}", "m3u8": r["m3u8"], "referer": r["referer"]})
        live = ev["date"] - 600000 <= now <= ev["date"] + 4 * 3600 * 1000  # started up to 4h ago
        out.append({
            "id": f"dl-{i}-{re.sub(r'[^a-z0-9]+', '-', ev['title'].lower())[:40]}",
            "title": ev["title"],
            "category": ev["category"],
            "date": ev["date"],
            "popular": ev["category"] in ("football", "motor-sports"),
            "live": live,
            "teams": None,
            "streams": streams,
        })

    out.sort(key=lambda e: (not e["live"], not e["popular"], e["date"]))
    with_streams = sum(1 for e in out if e["streams"])
    with open("feed.json", "w") as f:
        json.dump({"updated": now, "base": base, "count": len(out), "resolved": with_streams, "events": out}, f)
    print(f"done — {len(out)} events, {with_streams} with live streams")


if __name__ == "__main__":
    asyncio.run(main())
