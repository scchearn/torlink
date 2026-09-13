import { execFileSync, spawn, execFile } from "node:child_process";
import { existsSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chromecasts from "chromecasts";
import { startOnDemandServer, type SegmentPlan } from "./castServer";

// ponytail: fixed local players; AirPlay via pyatv CLI helper (no native Node deps).
// macOS app bundles (VLC, IINA) aren't on PATH, so probe bundle paths too.
export interface LocalPlayer {
  kind: "local";
  name: string;
  cmd: string;
  args: string[];
}

interface PlayerCandidate {
  name: string;
  args: string[];
  cmd: string;          // PATH binary name
  macBundle?: string;   // macOS app-bundle binary path, e.g. /Applications/VLC.app/Contents/MacOS/VLC
}

const CANDIDATES: PlayerCandidate[] = [
  { name: "VLC", cmd: "vlc", args: ["--play-and-exit", "--quiet"], macBundle: "/Applications/VLC.app/Contents/MacOS/VLC" },
  { name: "mpv", cmd: "mpv", args: ["--really-quiet", "--loop=no"] },
  { name: "IINA", cmd: "iina", args: [], macBundle: "/Applications/IINA.app/Contents/MacOS/iina" },
];

let localCache: LocalPlayer[] | null = null;

export function availableLocalPlayers(): LocalPlayer[] {
  if (localCache) return localCache;
  const probe = process.platform === "win32" ? "where" : "which";
  localCache = [];
  for (const c of CANDIDATES) {
    // macOS app bundle: check the bundle path first (VLC isn't on PATH).
    if (c.macBundle && process.platform === "darwin" && existsSync(c.macBundle)) {
      localCache.push({ kind: "local", name: c.name, cmd: c.macBundle, args: c.args });
      continue;
    }
    try {
      execFileSync(probe, [c.cmd], { stdio: "ignore" });
      localCache.push({ kind: "local", name: c.name, cmd: c.cmd, args: c.args });
    } catch {}
  }
  return localCache;
}

// The LAN IP cast devices use to reach the streaming server (which binds 0.0.0.0).
// Local players keep 127.0.0.1. Cached after first call.
let lanIpCache: string | null | undefined;
export function lanIp(): string | null {
  if (lanIpCache !== undefined) return lanIpCache;
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) {
        lanIpCache = a.address;
        return a.address;
      }
    }
  }
  lanIpCache = null;
  return null;
}

// Resolve the torrent listing URL to a direct file URL (or .m3u playlist).
// `baseUrl` is the address the target player can reach: 127.0.0.1 for local,
// LAN IP for cast devices.
async function resolveFileUrl(listingUrl: string, baseUrl: string): Promise<string> {
  // Replace the host in the listing URL with the target-reachable host.
  const url = listingUrl.replace("127.0.0.1", baseUrl);
  if (!url.endsWith("/")) return url;
  const res = await fetch(url);
  const html = await res.text();
  const entries = [...html.matchAll(/href="([^"]+)"[^>]*>\s*([^<]+?)\s*<\/a>\s*\((\d+)\s*bytes\)/g)];
  const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|mp3|flac|ogg|opus|wav|m4a)$/i;
  const videos = entries
    .map((m) => ({ href: m[1]!, name: m[2]!, bytes: Number(m[3]!) }))
    .filter((e) => VIDEO_EXT.test(e.name))
    .sort((a, b) => a.bytes - b.bytes);
  if (videos.length > 1) {
    const lines = ["#EXTM3U", ...videos.flatMap((v) => [`#EXTINF:-1,${v.name}`, new URL(encodeURI(v.href), url).href])];
    const { writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const playlistPath = path.join(tmpdir(), `torlnk-${Date.now()}.m3u`);
    writeFileSync(playlistPath, lines.join("\n"));
    return playlistPath;
  }
  if (videos.length === 1) return new URL(encodeURI(videos[0]!.href), url).href;
  const pool = entries.map((m) => ({ href: m[1]!, bytes: Number(m[3]!) }));
  const best = pool.sort((a, b) => b.bytes - a.bytes)[0];
  return best ? new URL(encodeURI(best.href), url).href : url;
}

export function launchLocalPlayer(player: LocalPlayer, url: string): void {
  void (async () => {
    try {
      const fileUrl = await resolveFileUrl(url, "127.0.0.1");
      const isMacBundle = process.platform === "darwin" && player.cmd.startsWith("/Applications/");
      if (isMacBundle) {
        const appName = player.cmd.match(/\/Applications\/(.+?)\.app/)?.[1] ?? player.name;
        const proc = spawn("open", ["-a", appName, fileUrl], { stdio: "ignore", detached: true });
        proc.on("error", () => {});
        proc.unref();
      } else {
        const proc = spawn(player.cmd, [...player.args, fileUrl], { stdio: "ignore", detached: true });
        proc.on("error", () => {});
        proc.unref();
      }
    } catch {}
  })();
}

export interface CastDevice {
  kind: "chromecast" | "airplay";
  name: string;
  id: string;
  model?: string; // pyatv DeviceModel string (airplay only)
  play: (url: string) => void;
}

// Lifecycle of a cast, surfaced to the UI. "preparing" covers resolve+probe;
// "transcoding" is the HLS remux buffering ahead; "playing" once the helper
// spawns; "failed" when anything in the chain throws. positionSec/durationSec
// ride along for the footer's now-playing readout once the receiver reports
// them.
export type CastStatus = {
  state: "preparing" | "transcoding" | "playing" | "failed";
  detail?: string;
  positionSec?: number;
  durationSec?: number;
};

export type CastStatusSink = (status: CastStatus) => void;

// --- AirPlay transcode fallback: tvOS only plays mp4/mov containers or HLS ---

// What a cast target can decode natively. We can't query decoder caps over
// AirPlay/Cast, so this is a known-model table with a conservative default;
// the TORLINK_CAST_PROFILE env var overrides for people who know their
// hardware.
//
// Sources: Apple tech specs (support.apple.com/111928, /111929, /111922) and
// Google's Cast media docs (developers.google.com/cast/docs/media).
//
// Nuances the table encodes:
// - ATV HD (A8) natively decodes HEVC Main/Main10 per Apple's spec, but
//   empirically rejects fmp4 HLS over AirPlay cast — and HEVC is only
//   carryable in fmp4 segments — so HEVC stays unavailable on the cast path.
// - ATV 4K models' fmp4-over-AirPlay behavior is UNVERIFIED (only Gen4 has
//   been tested); they are marked capable, and TORLINK_CAST_PROFILE=low is
//   the fallback if a given unit misbehaves.
// - HEVC in mpegts is unsupported on Cast receivers too, so canHevc always
//   implies segmentType fmp4.
export interface CastCapabilities {
  canHevc: boolean; // implies fmp4 segments (HEVC is not carryable in mpegts)
  can10bit: boolean;
  segmentType: "mpegts" | "fmp4";
}

const ATV_HD_A8: CastCapabilities = { canHevc: false, can10bit: false, segmentType: "mpegts" };
const ATV_MODERN: CastCapabilities = { canHevc: true, can10bit: true, segmentType: "fmp4" };
const CHROMECAST_H264: CastCapabilities = { canHevc: false, can10bit: false, segmentType: "mpegts" };
const CHROMECAST_HEVC: CastCapabilities = { canHevc: true, can10bit: true, segmentType: "fmp4" };

// Known Apple TV models by pyatv DeviceModel string.
const MODEL_CAPS: Record<string, CastCapabilities> = {
  "DeviceModel.Gen4": ATV_HD_A8, // Apple TV HD (A8)
  "DeviceModel.Gen4K": ATV_MODERN, // Apple TV 4K gen 1 (A10X)
  "DeviceModel.Gen5": ATV_MODERN, // Apple TV 4K gen 2 (A12)
  "DeviceModel.Gen6": ATV_MODERN, // Apple TV 4K gen 3 (A15)
};

// Chromecasts cannot be model-distinguished via the chromecasts npm package
// (it exposes only a name), so the default is the most common hardware:
// gen2/gen3, H.264-only per Google's docs. Ultra/Google TV owners set
// TORLINK_CAST_PROFILE=high.
export function capsForDevice(kind: string, deviceId: string): CastCapabilities {
  const override = process.env.TORLINK_CAST_PROFILE;
  if (override === "high") return kind === "chromecast" ? CHROMECAST_HEVC : ATV_MODERN;
  if (override === "low") return kind === "chromecast" ? CHROMECAST_H264 : ATV_HD_A8;
  if (kind === "chromecast") return CHROMECAST_H264;
  return MODEL_CAPS[deviceId] ?? CHROMECAST_H264;
}

export type AirplayPlan =
  | { mode: "direct" }
  | { mode: "transcode"; video: "copy" | "encode"; pixFmt: "copy" | "yuv420p" };

// `url` may be an http URL or a local file path (multi-file torrents resolve to an .m3u path).
// The plan is capability-aware: copy what the target decodes natively, encode
// the rest, and force 8-bit output only when the target needs it.
//
// Video copy has one hard precondition: the audio must ALSO be copyable
// (AAC-LC, HLS-compatible sample rate). When video is copied but audio is
// transcoded, each runner window's `-ss` becomes asymmetric: transcoded audio
// decode-discards to the exact seek point while stream-copied video can only
// start at the source keyframe <= that point — measured 2.2s desync on a
// typical rip whose GOPs run 2.75-10s (Jellyfin #9330 bug class), different
// on every seek. Encoding video avoids the asymmetry entirely: decode-accurate
// cutting aligns both streams to the same instant (verified <=23ms, AAC
// priming).
export function airplayPlan(
  url: string,
  vcodec: string | null,
  pixFmt: string | null,
  caps: CastCapabilities,
  audio: {
    codec: string | null;
    profile: string | null;
    sampleRate: number | null;
    channels: number | null;
  } | null,
): AirplayPlan {
  if (/\.(mp4|m4v|mov)$/i.test(url)) return { mode: "direct" };
  if (vcodec === null) return { mode: "direct" }; // ponytail: probe failed, try direct and hope
  const audioCopyable =
    audio?.codec === "aac" &&
    audio.profile !== "HE-AAC" &&
    audio.sampleRate !== null &&
    audio.sampleRate <= 48000 &&
    audio.channels !== null &&
    audio.channels <= 6;
  const tenBit = pixFmt?.includes("10le") ?? false;
  if (vcodec === "h264" && !(tenBit && !caps.can10bit)) {
    // Copy only when the audio rides along untouched; otherwise encode both.
    return { mode: "transcode", video: audioCopyable ? "copy" : "encode", pixFmt: "copy" };
  }
  if (vcodec === "hevc" && caps.canHevc && audioCopyable) {
    // HEVC requires fmp4 segments; the capability table only grants canHevc
    // when the target also accepts fmp4.
    return { mode: "transcode", video: "copy", pixFmt: "copy" };
  }
  // Foreign codec (or 10-bit on an 8-bit target), or copy-video whose audio
  // would need transcoding: re-encode, downconverting depth when the target
  // can't do 10-bit.
  return { mode: "transcode", video: "encode", pixFmt: tenBit && !caps.can10bit ? "yuv420p" : "copy" };
}

function probeVideoCodec(url: string): Promise<string | null> {
  return probeStreams(url).then((s) => s?.vcodec ?? null);
}

interface ProbedStream {
  vcodec: string | null;
  pixFmt: string | null;
  durationSec: number | null;
  audioLangs: string[]; // per audio stream, language tag or ""
  audio: {
    codec: string | null;
    profile: string | null;
    sampleRate: number | null;
    channels: number | null;
  } | null;
}

function probeStreams(url: string): Promise<ProbedStream | null> {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "stream=codec_name,codec_type,pix_fmt,profile,sample_rate,channels:stream_tags=language:format=duration",
        "-of", "json", url,
      ],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const parsed = JSON.parse(stdout);
          const streams = parsed.streams ?? [];
          const duration = Number(parsed.format?.duration);
          const video = streams.find((s: { codec_type?: string }) => s.codec_type === "video");
          const audio = streams.find((s: { codec_type?: string }) => s.codec_type === "audio");
          resolve({
            vcodec: video?.codec_name ?? null,
            pixFmt: video?.pix_fmt ?? null,
            durationSec: Number.isFinite(duration) ? duration : null,
            audioLangs: streams
              .filter((s: { codec_type?: string }) => s.codec_type === "audio")
              .map((s: { tags?: { language?: string } }) => s.tags?.language ?? ""),
            audio: audio
              ? {
                  codec: audio.codec_name ?? null,
                  profile: audio.profile ?? null,
                  sampleRate: Number(audio.sample_rate) || null,
                  channels: Number(audio.channels) || null,
                }
              : null,
          });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// One cast server at a time: a new cast stops the previous one and deletes its
// temp dir. Concurrent transcodes of the same in-progress torrent starve each
// other (three readers thrash the piece cache) and fill disk.
let activeTranscode: { stop: () => void; dir: string } | null = null;

function stopActiveTranscode(): void {
  if (!activeTranscode) return;
  activeTranscode.stop();
  removeDir(activeTranscode.dir);
  activeTranscode = null;
}

function removeDir(dir: string): void {
  try {
    for (const f of readdirSync(dir)) unlinkSync(path.join(dir, f));
    rmdirSync(dir);
  } catch {}
}

// Delete torlnk-cast-* dirs left by crashed runs or killed dev servers. Only
// one transcode is ever active, so any other dir is garbage.
function cleanStaleTranscodeDirs(): void {
  try {
    for (const f of readdirSync(tmpdir())) {
      if (f.startsWith("torlnk-cast-")) removeDir(path.join(tmpdir(), f));
    }
  } catch {}
}
process.on("exit", stopActiveTranscode);

// Build the var_stream_map: one audio-only variant per audio track (stereo aac,
// selectable on the ATV via EXT-X-MEDIA renditions) + one video-only variant.
// The first track is the default; language tags pass through verbatim when present.
export function buildVarStreamMap(audioLangs: string[]): { map: string; defaultIdx: number } {
  const parts = audioLangs.map((lang, i) => {
    const langPart = lang ? `,language:${lang.toUpperCase().slice(0, 3)}` : "";
    return `a:${i},agroup:aud${langPart},default:${i === 0 ? "YES" : "NO"}`;
  });
  parts.push(`v:0,agroup:aud`);
  return { map: parts.join(" "), defaultIdx: 0 };
}

// Start the on-demand cast server for one cast: a complete VOD playlist is
// written instantly (full scrub bar, native ATV seeking) and each 2s segment
// is transcoded the first time the receiver requests it — mpv-style. Only
// watched content is ever computed.
async function airplayTranscode(
  url: string,
  video: "copy" | "encode",
  pixFmt: "copy" | "yuv420p",
  segmentType: "mpegts" | "fmp4",
  sourceHevc: boolean,
  audioLangs: string[],
  onStatus?: CastStatusSink,
  startSec = 0,
  durationSec: number | null = null,
): Promise<string> {
  onStatus?.({ state: "transcoding" });
  stopActiveTranscode();
  cleanStaleTranscodeDirs();
  if (!durationSec) throw new Error("cannot determine media duration");
  const plan: SegmentPlan = {
    sourceUrl: url, durationSec, audioLangs, video, pixFmt, segmentType, sourceHevc, startSec,
  };
  const ip = lanIp() ?? "127.0.0.1";
  const server = await startOnDemandServer(plan, ip, (pct) => {
    onStatus?.({ state: "transcoding", detail: `${pct}%` });
  });
  activeTranscode = { stop: server.stop, dir: server.dir };
  return server.url;
}

// The AirPlay cast currently active: which helper process is playing and on
// which device, so `S` can kill the helper AND tear the ATV session down.
// Null when the active cast is Chromecast (whose stop is just killing the
// transcode, or nothing at all).
let activeAirplayCast: {
  pyBin: string;
  helperScript: string;
  id: string;
  env: NodeJS.ProcessEnv;
  helper: ReturnType<typeof spawn> | null;
} | null = null;

// Stop the active cast. Two-step teardown: kill the play helper (its session
// watcher hangs once the RTSP channel dies, so it must not outlive us), then
// run `airplay.py stop` to make the ATV drop playback cleanly. Safe to call
// when nothing is active.
export function stopActiveCast(): void {
  const cast = activeAirplayCast;
  activeAirplayCast = null;
  if (cast) {
    // Kill the play helper first so it can't reconnect or linger.
    try {
      cast.helper?.kill("SIGTERM");
    } catch {}
    // Best-effort session teardown on the device itself.
    try {
      const proc = spawn(cast.pyBin, [cast.helperScript, "stop", cast.id], {
        stdio: "ignore", detached: true, env: cast.env,
      });
      proc.on("error", () => {});
      proc.unref();
    } catch {}
  }
  stopActiveTranscode();
}

export function activeCastKind(): "airplay" | "chromecast" | null {
  return activeTranscode ? "airplay" : castsInstance ? "chromecast" : null;
}

// --- Chromecast (pure JS, via the chromecasts npm package) ---

let castsInstance: ReturnType<typeof chromecasts> | null = null;

// Walk up from this module to the package root to find scripts/airplay.py.
// The bundled build flattens to dist/index.js while dev runs from src/util/,
// so a fixed relative path only works for one of the two.
export function findHelperScript(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "scripts", "airplay.py");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join("scripts", "airplay.py");
}

// Run the airplay helper for one device: resolve → probe → transcode → spawn
// `play`. The helper keeps stderr; on failure its TORLNK_ERR line becomes the
// status detail. The play process is detached so playback survives torlnk.
// Seek handling: the helper reports the receiver's position as POS:<sec> lines
// on stdout. When the user scrubs past the transcode edge (content that doesn't
// exist yet), we restart the transcode at the target position and recast —
// the same approach Plex/Jellyfin use, with a brief reload on the TV.
// With the on-demand server, the ATV natively seeks anywhere (the playlist is
// a full VOD), so the runCycle restart machinery only remains for the UI
// seek keys; the receiver-driven seek detection is gone.
function castViaHelper(
  pyBin: string,
  helperScript: string,
  id: string,
  model: string,
  url: string,
  env: NodeJS.ProcessEnv,
  onStatus?: CastStatusSink,
): void {
  void (async () => {
    try {
      onStatus?.({ state: "preparing" });
      const ip = lanIp();
      const castUrl = ip ? url.replace("127.0.0.1", ip) : url;
      const fileUrl = await resolveFileUrl(castUrl, ip ?? "127.0.0.1");
      const probe = await probeStreams(fileUrl);
      const caps = capsForDevice("airplay", model);
      const plan = airplayPlan(fileUrl, probe?.vcodec ?? null, probe?.pixFmt ?? null, caps, probe?.audio ?? null);
      const langs = probe?.audioLangs ?? [];
      const duration = probe?.durationSec ?? null;

      // One full cast cycle at a start position. Returns when the helper
      // exits; `seekedTo` is set when a UI seek arrived mid-cycle.
      const runCycle = async (
        startSec: number,
      ): Promise<{ code: number | null; errTail: string; seekedTo: number | null }> => {
        const finalUrl =
          plan.mode === "transcode"
            ? await airplayTranscode(
                fileUrl, plan.video, plan.pixFmt, caps.segmentType,
                probe?.vcodec === "hevc", langs, onStatus, startSec, duration,
              )
            : fileUrl;
        const helper = spawn(
          pyBin,
          [helperScript, "play", id, finalUrl, "--report-pos"],
          { stdio: ["ignore", "pipe", "pipe"], detached: true, env },
        );
        helper.unref();
        activeAirplayCast = { pyBin, helperScript, id, env, helper };
        let seekedTo: number | null = null;
        let errTail = "";
        helper.stderr?.on("data", (chunk: Buffer) => {
          errTail = (errTail + chunk.toString()).split("\n").slice(-8).join("\n");
        });
        let buffer = "";
        helper.stdout?.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith("POS:")) continue;
            // POS:<elapsed>[:<duration>] — duration rides along when the
            // receiver reports it.
            const parts = line.slice(4).split(":");
            const pos = Number(parts[0]);
            if (!Number.isFinite(pos)) continue;
            lastPosition = startSec + pos;
            onStatus?.({
              state: "playing",
              positionSec: lastPosition,
              ...(parts[1] ? { durationSec: startSec + Number(parts[1]) } : {}),
            });
          }
        });
        const code = await new Promise<number | null>((resolve) => {
          const startupMs = 45_000;
          const timer = setTimeout(() => {
            helper.removeListener("exit", onExit);
            resolve(null); // still running → treat as playing
          }, startupMs);
          const onExit = (c: number | null): void => {
            clearTimeout(timer);
            resolve(c);
          };
          helper.once("exit", onExit);
        });
        // A UI-requested seek (,/. keys): the helper is killed by castSeek();
        // consume the target here so the outer loop restarts at the new spot.
        if (pendingSeek !== null) {
          seekedTo = pendingSeek;
          pendingSeek = null;
        }
        if (activeAirplayCast?.helper === helper) activeAirplayCast = null;
        return { code, errTail, seekedTo };
      };

      let position = 0;
      for (;;) {
        const { code, errTail, seekedTo } = await runCycle(position);
        if (seekedTo !== null) {
          position = seekedTo;
          continue; // restart transcode + recast at the new spot
        }
        if (code !== null && code !== 0) {
          const errLine = errTail.split("\n").reverse().find((l) => l.startsWith("TORLNK_ERR: "));
          onStatus?.({ state: "failed", detail: errLine?.replace(/^TORLNK_ERR: /, "") ?? "AirPlay helper failed" });
          return;
        }
        onStatus?.({ state: "playing" });
        return;
      }
    } catch (e) {
      onStatus?.({ state: "failed", detail: e instanceof Error ? e.message : String(e) });
    }
  })();
}

// Pending UI seek target for the active AirPlay cast, in seconds. Set by
// castSeek(); consumed by the runCycle loop on the next iteration.
let pendingSeek: number | null = null;

// Last receiver-reported position (absolute, seconds), for relative seeks.
let lastPosition = 0;

// Seek the active AirPlay cast. A negative/positive delta seeks relative to
// the last reported position; an absolute target can be passed via options.
// No-op when nothing is casting via AirPlay. The ATV's own remote scrub seeks
// natively now (full VOD playlist); this path is for torlnk's keyboard seek.
export function castSeek(deltaSec: number, opts?: { absolute?: boolean }): void {
  if (!activeAirplayCast) return;
  pendingSeek = opts?.absolute ? Math.max(0, deltaSec) : Math.max(0, lastPosition + deltaSec);
  activeAirplayCast.helper?.kill("SIGTERM");
}

// Pause or resume the active AirPlay cast. Control-plane side call: the
// helper's play session stays alive; this just sends the remote command.
// Best-effort — the helper treats failure as exit 0.
export function castPauseResume(action: "pause" | "resume"): void {
  const cast = activeAirplayCast;
  if (!cast) return;
  try {
    const proc = spawn(cast.pyBin, [cast.helperScript, action, cast.id], {
      stdio: "ignore", detached: true, env: cast.env,
    });
    proc.on("error", () => {});
    proc.unref();
  } catch {}
}

export function startCastDiscovery(
  onDevice: (device: CastDevice) => void,
  onStatus?: CastStatusSink,
): () => void {
  castsInstance?.destroy();
  const casts = chromecasts();
  castsInstance = casts;
  const helperScript = findHelperScript();
  const onUpdate = (player: { name: string; play: (url: string, opts: { title: string }, cb: (err?: Error) => void) => void }): void =>
    onDevice({
      kind: "chromecast",
      name: player.name,
      id: player.name,
      play: (url: string) => {
        void (async () => {
          const ip = lanIp();
          const castUrl = ip ? url.replace("127.0.0.1", ip) : url;
          const fileUrl = await resolveFileUrl(castUrl, ip ?? "127.0.0.1");
          player.play(fileUrl, { title: "torlnk" }, () => {});
        })();
      },
    });
  casts.on("update", onUpdate);

  // --- AirPlay (via pyatv Python helper, if available) ---
  let airplayStop: (() => void) | null = null;
  const pyatvCompatDir = process.env.TORLINK_PYATV_COMPAT_DIR ?? "/Users/samuelhearn/iptv";
  // Find a python with pyatv installed: try the iptv venv first, then system.
  const pyCandidates = ["/Users/samuelhearn/iptv/venv/bin/python", "python3"];
  let pyBin: string | null = null;
  for (const p of pyCandidates) {
    try {
      execFileSync(p, ["-c", "import pyatv"], { stdio: "ignore", env: { ...process.env, PYTHONPATH: pyatvCompatDir } });
      pyBin = p;
      break;
    } catch {}
  }
  if (pyBin) {
    const env = { ...process.env, PYTHONPATH: pyatvCompatDir };
    execFile(pyBin, [helperScript, "scan"], { env, timeout: 10000 }, (err, stdout) => {
      if (err) return;
      for (const line of stdout.trim().split("\n")) {
        const [id, name, model] = line.split("\t");
        if (id && name) {
          onDevice({
            kind: "airplay",
            name: `AirPlay: ${name}`,
            id,
            model,
            play: (url: string) => {
              castViaHelper(pyBin!, helperScript, id, model ?? "", url, env, onStatus);
            },
          });
        }
      }
    });
  }

  return () => {
    if (castsInstance === casts) castsInstance = null;
    casts.off("update", onUpdate);
    casts.destroy();
  };
}
