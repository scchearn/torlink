import { fetchResilient, HttpError, USER_AGENT } from "../util/net";
import { buildMagnet } from "./magnet";
import type { SearchOptions, Source, SourceId, TorrentResult } from "./types";

// Skwirll scene-release feed (https://skwirll.com/api): a pre database that
// announces new releases within minutes. The scene names carry no magnets or
// swarm data, so this source is a discovery layer — each unique title is
// fanned out to apibay (TPB's API) by IMDb id to attach real torrents and
// rank by actual swarm heat.
//
// The default browse is a 7-day window: one request per day endpoint, deduped
// by IMDb id keeping the FIRST sighting (when the release dropped). Titles
// then rank by the best seeder count apibay knows about, so "new and hot"
// floats up — neither a seeders-ranked top-100 nor a raw date sort surfaces
// an anticipated release the way this combination does.

const API = "https://skwirll.com/api";
const APIBAY = "https://apibay.org";
const WINDOW_DAYS = 7;

interface SkwirllRelease {
  name?: string;
  category?: string;
  imdb_id?: string | null;
  created_at?: number;
  size?: number;
  files?: number;
}

// The feed carries every scene category; only these interest the Movies tab.
const MOVIE = "MOVIE";

// Scene releases are heavily multi-language. Rows tagged with these markers
// are dubs/localizations that drown out English releases; they stay in the
// list but sink below everything untagged.
const DUB_MARKERS = /\b(german|polish|italian|french|dutch|spanish|dublado|danish|swedish|norwegian|finnish|multi)\b/i;

interface ImdbEntry {
  at: number;
  seeders: number;
  row?: {
    info_hash?: string;
    name?: string;
    size?: string;
    leechers?: string;
    added?: string;
  };
}

// Swarm heat changes slowly; a per-IMDb cache (with the winning apibay row
// attached) keeps repeated views cheap and stays far inside apibay's
// patience. 30 min TTL, bounded — one map, one eviction path, no races
// between a seeders map and a rows map.
const imdbCache = new Map<string, ImdbEntry>();
const SEEDERS_TTL_MS = 30 * 60 * 1000;
const IMDB_CACHE_MAX = 500;

// Day responses are identical for every caller within the hour; caching them
// halves the Skwirll request cost for repeat views. Bounded by pruning dates
// older than the window.
const dayCache = new Map<string, { at: number; releases: SkwirllRelease[] }>();
const DAY_TTL_MS = 60 * 60 * 1000;

// The final ranked view is expensive on a cold cache (~30 apibay round-trips
// serialized), so it's cached itself with a longer TTL than the generic
// search cache. Warm views are instant; the seeders within it still refresh
// every 30 min via the per-IMDb cache when the view expires.
let viewCache: { at: number; results: TorrentResult[] } | null = null;
const VIEW_TTL_MS = 15 * 60 * 1000;

// apibay fan-out runs with bounded concurrency: fully serialized wastes the
// cold view (~150 round-trips × 0.9s), while unbounded bursts risk rate
// limiting. Eight at a time keeps a 150-title cold view around 30s and warm
// views instant via the caches.
const APIBAY_CONCURRENCY = 8;
let apibayActive = 0;
const apibayWaiters: Array<() => void> = [];

async function acquireApibaySlot(): Promise<void> {
  if (apibayActive < APIBAY_CONCURRENCY) {
    apibayActive++;
    return;
  }
  await new Promise<void>((resolve) => apibayWaiters.push(resolve));
  apibayActive++;
}

function releaseApibaySlot(): void {
  apibayActive--;
  const next = apibayWaiters.shift();
  if (next) next();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function pastIso(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function fetchDay(day: string, opts: SearchOptions): Promise<SkwirllRelease[]> {
  const hit = dayCache.get(day);
  if (hit && Date.now() - hit.at < DAY_TTL_MS) return hit.releases;
  const res = await fetchResilient(`${API}/releases/${day}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: opts.signal,
    retries: 1,
  });
  if (!res.ok) throw new HttpError(res.status, `Skwirll returned ${res.status}`);
  const json = (await res.json()) as { data?: SkwirllRelease[] };
  const releases = Array.isArray(json.data) ? json.data : [];
  dayCache.set(day, { at: Date.now(), releases });
  // Prune dates that have fallen out of any plausible window.
  const cutoff = pastIso(WINDOW_DAYS + 2);
  for (const key of dayCache.keys()) {
    if (key < cutoff) dayCache.delete(key);
  }
  return releases;
}

async function seedersForImdb(imdb: string, opts: SearchOptions): Promise<ImdbEntry> {
  const hit = imdbCache.get(imdb);
  if (hit && Date.now() - hit.at < SEEDERS_TTL_MS) return hit;
  await acquireApibaySlot();
  try {
    const fresh = imdbCache.get(imdb);
    if (fresh && Date.now() - fresh.at < SEEDERS_TTL_MS) return fresh;
    try {
      const res = await fetchResilient(`${APIBAY}/q.php?q=${encodeURIComponent(imdb)}&cat=0`, {
        headers: { "User-Agent": USER_AGENT },
        signal: opts.signal,
        retries: 1,
      });
      if (!res.ok) throw new HttpError(res.status, `apibay returned ${res.status}`);
      const json = (await res.json()) as Array<{ id?: string; seeders?: string; info_hash?: string; name?: string; size?: string; leechers?: string; added?: string }>;
      let best: { seeders: number; row: (typeof json)[number] } | null = null;
      for (const row of json) {
        if (!row.info_hash || row.info_hash === "0000000000000000000000000000000000000000" || row.id === "0") continue;
        const s = Number(row.seeders) || 0;
        if (!best || s > best.seeders) best = { seeders: s, row };
      }
      const entry: ImdbEntry = {
        at: Date.now(),
        seeders: best?.seeders ?? 0,
        row: best?.row,
      };
      imdbCache.set(imdb, entry);
      while (imdbCache.size > IMDB_CACHE_MAX) {
        const oldest = imdbCache.keys().next().value;
        if (oldest === undefined) break;
        imdbCache.delete(oldest);
      }
      return entry;
    } catch {
      // apibay down or rate-limited: report unknown heat rather than killing
      // the whole view. Negative seeders marks it unknown; the row is dropped
      // since there's no magnet to attach anyway.
      return { at: Date.now(), seeders: -1 };
    }
  } finally {
    releaseApibaySlot();
  }
}

// A scene name is dotted; recover readable words for display and search.
function readableName(scene: string): string {
  return scene
    .replace(/\.(?=[a-z0-9]{2,})/gi, " ")
    .replace(/\b(1080p|720p|2160p|480p|PAL|DVD9|DVD5|NTSC|COMPLETE|1080i|PAL\.?DVD|BluRay|BDRip|DVDRip|HDTV|WEB|WEB[-.]?DL|x264|x265|H\.?264|H\.?265|HEVC|AAC|DDP?5?\.?[01]?|EAC3D?|DTSD?|HDR|DV|REMUX|PROPER|REPACK|UHD|REMASTERED|EXTENDED|iNTERNAL|SUBBED|DUBBED|DL)\b/gi, " ")
    // Language tags (iTALiAN, GERMAN DL, MULTi, …) — scene casing is
    // intentionally irregular, so match case-insensitively on the shared
    // marker list.
    .replace(new RegExp(`\\b(${DUB_MARKERS.source.slice(3, -3)})\\b(\\s+DL)?\\b`, "gi"), " ")
    // Release group suffix: dash-attached token at the end (scene convention:
    // "Name-GRP"). Marker-stripping turns ".x264-GRP" into " GRP", so match
    // the dash form before dots collapse and the space form after.
    .replace(/-([A-Z0-9]{2,12})$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- TMDB canonical titles ---
//
// Scene names are noisy (foreign titles, PAL/DVD9 artifacts, group tags). With
// a TMDB key (config.tmdbKey or TORLINK_TMDB_KEY), each unique IMDb id is
// resolved to the canonical "Title (Year)" via TMDB's /find endpoint. Movie
// titles never change, so the cache has no TTL — only a size bound. Without a
// key or on any TMDB failure, the cleaned scene name is the fallback.

interface TmdbTitle {
  title: string;
  year: number | null;
}

const tmdbCache = new Map<string, TmdbTitle | null>();
const TMDB_CACHE_MAX = 1000;
let tmdbKey = "";

export function setTmdbKey(key: string): void {
  tmdbKey = key.trim();
}

// Batched resolution: the caller hands over all unique IMDb ids at once and
// gets a map back. Resolution failures cache null so a flaky network doesn't
// re-hit TMDB for the same id every view.
async function resolveTitles(imdbIds: string[], opts: SearchOptions): Promise<Map<string, TmdbTitle>> {
  const out = new Map<string, TmdbTitle>();
  const pending: string[] = [];
  for (const id of imdbIds) {
    if (tmdbCache.has(id)) {
      const t = tmdbCache.get(id);
      if (t) out.set(id, t);
    } else {
      pending.push(id);
    }
  }
  if (!tmdbKey || pending.length === 0) return out;

  // Bounded concurrency, same shape as the apibay fan-out.
  let idx = 0;
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    for (;;) {
      const id = pending[idx++];
      if (id === undefined) return;
      try {
        // TMDB accepts a v3 api key (query param) or a v4 read-access token
        // (JWT-looking, Bearer header). Support both — users paste whichever
        // their account page shows.
        const isV4Token = tmdbKey.startsWith("eyJ");
        const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(id)}?external_source=imdb_id${isV4Token ? "" : `&api_key=${encodeURIComponent(tmdbKey)}`}`;
        const res = await fetchResilient(url, {
          headers: {
            "User-Agent": USER_AGENT,
            ...(isV4Token ? { Authorization: `Bearer ${tmdbKey}` } : {}),
          },
          signal: opts.signal,
          retries: 1,
        });
        if (!res.ok) throw new HttpError(res.status, `TMDB returned ${res.status}`);
        const json = (await res.json()) as {
          movie_results?: Array<{ title?: string; release_date?: string }>;
        };
        const movie = json.movie_results?.[0];
        if (movie?.title) {
          const year = movie.release_date ? Number(movie.release_date.slice(0, 4)) : null;
          const t: TmdbTitle = { title: movie.title, year: Number.isFinite(year) ? year : null };
          tmdbCache.set(id, t);
          out.set(id, t);
        } else {
          tmdbCache.set(id, null); // not on TMDB; stop retrying
        }
        while (tmdbCache.size > TMDB_CACHE_MAX) {
          const oldest = tmdbCache.keys().next().value;
          if (oldest === undefined) break;
          tmdbCache.delete(oldest);
        }
      } catch {
        // Network/key failure: null caches the miss; the scene-name fallback
        // covers this row.
        tmdbCache.set(id, null);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function displayName(scene: string, resolved: TmdbTitle | undefined): string {
  if (resolved) {
    return resolved.year ? `${resolved.title} (${resolved.year})` : resolved.title;
  }
  return readableName(scene);
}

export async function newReleases(opts: SearchOptions = {}): Promise<TorrentResult[]> {
  if (viewCache && Date.now() - viewCache.at < VIEW_TTL_MS) return viewCache.results;

  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => pastIso(i));
  const perDay = await Promise.all(days.map((d) => fetchDay(d, opts)));

  // Dedupe by IMDb keeping the FIRST sighting (when the release dropped).
  const byImdb = new Map<string, SkwirllRelease>();
  for (const releases of perDay) {
    for (const r of releases) {
      if (r.category !== MOVIE || !r.imdb_id || !r.name) continue;
      const existing = byImdb.get(r.imdb_id);
      if (!existing || (r.created_at ?? 0) < (existing.created_at ?? 0)) byImdb.set(r.imdb_id, r);
    }
  }

  // Rank: best apibay seeder count per IMDb, descending. Unknown heat (-1)
  // sorts last and is dropped (no magnet to attach). Dubs sink below
  // untagged releases of equal heat.
  const scored = await Promise.all(
    [...byImdb.entries()].map(async ([imdb, r]) => ({
      imdb,
      r,
      entry: await seedersForImdb(imdb, opts),
    })),
  );
  scored.sort((a, b) => {
    const dubA = DUB_MARKERS.test(a.r.name!) ? 1 : 0;
    const dubB = DUB_MARKERS.test(b.r.name!) ? 1 : 0;
    if (dubA !== dubB) return dubA - dubB;
    return b.entry.seeders - a.entry.seeders;
  });

  // Canonical titles via TMDB (no-op without a key; scene-name fallback then).
  const names = await resolveTitles(
    scored.filter((s) => s.entry.seeders >= 0).map((s) => s.imdb),
    opts,
  );

  const out: TorrentResult[] = [];
  for (const { imdb, r, entry } of scored) {
    if (entry.seeders < 0 || !entry.row?.info_hash) continue;
    const infoHash = entry.row.info_hash.toLowerCase();
    const display = displayName(r.name!, names.get(imdb));
    out.push({
      infoHash,
      name: display || r.name!,
      sizeBytes: Number(entry.row.size) || 0, // apibay size is bytes
      seeders: entry.seeders,
      leechers: Number(entry.row.leechers) || 0,
      source: "skwirll",
      magnet: buildMagnet(infoHash, entry.row.name || display, []),
      added: Number(entry.row.added) || r.created_at,
    });
  }
  viewCache = { at: Date.now(), results: out };
  return out;
}

export interface NewReleaseTitle {
  imdb: string;
  title: string;
  seeders: number;
  addedAt?: number;
}

// Title-level view for the New Releases tab: one row per unique movie, ranked
// by swarm heat. Shares the same caches as newReleases, so switching between
// the tab and a drilled-down torrent search costs nothing.
export async function browseTitles(opts: SearchOptions = {}): Promise<NewReleaseTitle[]> {
  await newReleases(opts); // warm the shared caches
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => pastIso(i));
  const perDay = await Promise.all(days.map((d) => fetchDay(d, opts)));
  const byImdb = new Map<string, SkwirllRelease>();
  for (const releases of perDay) {
    for (const r of releases) {
      if (r.category !== MOVIE || !r.imdb_id || !r.name) continue;
      const existing = byImdb.get(r.imdb_id);
      if (!existing || (r.created_at ?? 0) < (existing.created_at ?? 0)) byImdb.set(r.imdb_id, r);
    }
  }
  // Canonical titles for the rows the torrent lookup already confirmed.
  const resolvable = [...byImdb.keys()].filter((imdb) => {
    const e = imdbCache.get(imdb);
    return e && e.seeders >= 0 && e.row?.info_hash;
  });
  const names = await resolveTitles(resolvable, opts);
  const titles: NewReleaseTitle[] = [];
  for (const [imdb, r] of byImdb) {
    const entry = imdbCache.get(imdb);
    if (!entry || entry.seeders < 0 || !entry.row?.info_hash) continue; // no torrent source yet
    titles.push({
      imdb,
      title: displayName(r.name!, names.get(imdb)),
      seeders: entry.seeders,
      addedAt: Number(entry.row.added) || r.created_at,
    });
  }
  titles.sort((a, b) => b.seeders - a.seeders);
  return titles;
}

export const skwirll: Source = {
  id: "skwirll",
  label: "New",
  groups: ["New Releases"],
  homepage: "https://skwirll.com",
  // The ranking comes from apibay's real swarm counts.
  reportsHealth: true,
  // The browse view IS the feature; text search falls through to it and the
  // UI's own filter does the narrowing.
  search: (_query, opts = {}) => newReleases(opts),
};

// Exported for tests.
export const _internals = { readableName, DUB_MARKERS, todayIso, pastIso };
