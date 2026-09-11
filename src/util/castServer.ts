import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";

// On-demand HLS transcode server for AirPlay casting.
//
// Writes a complete VOD playlist upfront — the receiver gets a normal VOD with
// a full scrub bar and native seeking — and transcodes content on demand
// (mpv-style, same idea as hls-vod-too).
//
// Transcoding runs through a RUNNER: one continuous ffmpeg process that encodes
// a window of segments (RUN_SEGMENT_COUNT) starting at an anchor segment. This
// matters for A/V sync: per-segment ffmpeg spawns re-seek independently and
// lose audio at every boundary (~1% cumulative drift), while one continuous
// encode is sample-locked — zero drift within a run. A far seek kills the
// runner and re-anchors at the target; one re-anchor per seek, not one per
// segment.
//
// The encode grid is frame-exact: the fps filter normalizes to FPS (24 divides
// 2s into whole frames) and force_key_frames pins segment cuts, so every
// segment is exactly 2.000s — matching the declared EXTINF and keeping the
// receiver's timeline honest over a whole movie.

export interface SegmentPlan {
  sourceUrl: string;
  durationSec: number;
  audioLangs: string[];
  video: "copy" | "encode";
  pixFmt: "copy" | "yuv420p"; // forced 8-bit output for 8-bit-only targets
  segmentType: "mpegts" | "fmp4";
  sourceHevc: boolean; // copy mode: master playlist must advertise hvc1
  startSec: number;
}

const SEGMENT_SEC = 2;
const FPS = 24; // divides SEGMENT_SEC into whole frames
const RUN_SEGMENT_COUNT = 45; // 90s of content per runner window

export function segmentCount(plan: SegmentPlan): number {
  return Math.max(1, Math.ceil((plan.durationSec - plan.startSec) / SEGMENT_SEC));
}

// Playlist for one variant: every segment declared, VOD-terminated. Segment
// files may not exist yet — the runner produces them on demand.
function variantPlaylist(count: number, ext: "ts" | "m4s"): string {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${SEGMENT_SEC}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  for (let i = 0; i < count; i++) {
    lines.push("#EXTINF:2.000000,", `seg${i}.${ext}`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

export function buildMasterPlaylist(plan: SegmentPlan): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  plan.audioLangs.forEach((lang, i) => {
    const tag = lang ? `,LANGUAGE="${lang.toUpperCase().slice(0, 3)}"` : "";
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio_${i}"${tag},DEFAULT=${i === 0 ? "YES" : "NO"},CHANNELS="2",URI="${i}/playlist.m3u8"`,
    );
  });
  // HEVC copy requires hvc1 in CODECS; h264 re-encode matches the runner's
  // output (High@4.0). Audio is always AAC-LC stereo.
  const vcodec = plan.video === "copy" && plan.sourceHevc ? "hvc1.1.6.L120.90" : "avc1.640028";
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="${vcodec},mp4a.40.2",AUDIO="aud"`);
  lines.push("v/playlist.m3u8");
  return lines.join("\n") + "\n";
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "0.0.0.0", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// One continuous ffmpeg encode: segments [fromSeg, toSeg), cut at exact 2s
// input boundaries. Exits on its own at the window end. The video variant is
// the runner's output; audio variants are produced by separate light runners
// (audio-only encode is ~10x cheaper and its own window keeps the queue simple).
function spawnRunner(plan: SegmentPlan, dir: string, fromSeg: number, toSeg: number): ChildProcess {
  const start = plan.startSec + fromSeg * SEGMENT_SEC;
  const duration = (toSeg - fromSeg) * SEGMENT_SEC;
  const filters = [`fps=${FPS}`];
  // 8-bit-only targets need explicit downconversion; capable targets keep the
  // source depth (copy mode ignores this entirely).
  if (plan.pixFmt === "yuv420p") filters.push("format=yuv420p");
  const copy = plan.video === "copy";
  const args = [
    "-y",
    "-ss", start.toFixed(3),
    "-i", plan.sourceUrl,
    "-t", duration.toFixed(3),
    "-map", "0:v:0",
  ];
  if (copy) {
    // Stream copy: no filters (filters require re-encode). Keyframe-aligned
    // cutting relies on the source's own GOP; segment boundaries may drift
    // slightly from the 2s grid, which the playlist's real EXTINF values
    // would need to reflect — copy mode is only granted for well-formed
    // sources, so this is acceptable.
    args.push("-c:v", "copy");
  } else {
    args.push("-vf", filters.join(",").replace(/^,/, ""));
    args.push("-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SEC})`);
    args.push("-c:v", "libx264", "-preset", "veryfast");
  }
  args.push(
    "-f", "hls",
    "-hls_time", String(SEGMENT_SEC),
    "-hls_list_size", "0",
    "-hls_segment_type", plan.segmentType,
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(dir, "v", `seg%d.${plan.segmentType === "fmp4" ? "m4s" : "ts"}`),
    "-start_number", String(fromSeg),
    "-master_pl_name", "runner.m3u8",
    path.join(dir, "runner-v.m3u8"),
  );
  return spawn("ffmpeg", args, { stdio: "ignore" });
}

// Audio-only runner for one track: same grid, ~10x cheaper than video.
function spawnAudioRunner(plan: SegmentPlan, dir: string, track: number, fromSeg: number, toSeg: number): ChildProcess {
  const start = plan.startSec + fromSeg * SEGMENT_SEC;
  const duration = (toSeg - fromSeg) * SEGMENT_SEC;
  const args = [
    "-y",
    "-ss", start.toFixed(3),
    "-i", plan.sourceUrl,
    "-t", duration.toFixed(3),
    "-map", `0:a:${track}`,
    "-vn",
    "-af", "aresample=async=1:first_pts=0",
    "-c:a", "aac", "-b:a", "192k", "-ac", "2",
    "-f", "hls",
    "-hls_time", String(SEGMENT_SEC),
    "-hls_list_size", "0",
    "-hls_segment_type", "mpegts",
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(dir, String(track), "seg%d.ts"),
    "-start_number", String(fromSeg),
    "-master_pl_name", "runner.m3u8",
    path.join(dir, `runner-${track}.m3u8`),
  ];
  return spawn("ffmpeg", args, { stdio: "ignore" });
}

function reportProgress(dir: string, plan: SegmentPlan, onProgress?: (pct: number) => void): void {
  if (!onProgress) return;
  try {
    const count = readdirSync(path.join(dir, "v")).filter((f) => f.endsWith(".ts")).length;
    onProgress(Math.min(99, Math.round((count / segmentCount(plan)) * 100)));
  } catch {}
}

function serveFile(res: http.ServerResponse, file: string, contentType: string): void {
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": statSync(file).size });
  createReadStream(file).pipe(res);
}

interface RunnerState {
  proc: ChildProcess | null;
  fromSeg: number;
  toSeg: number;
}

// Start the server. Returns the master playlist URL (with the given host IP)
// and a stop function that closes the HTTP server and kills the runners;
// generated segments stay on disk until the caller removes the directory.
export async function startOnDemandServer(
  plan: SegmentPlan,
  lanIp: string,
  onProgress?: (pct: number) => void,
): Promise<{ url: string; dir: string; stop: () => void }> {
  const dir = path.join(tmpdir(), `torlnk-cast-${Date.now()}`);
  mkdirSync(path.join(dir, "v"), { recursive: true });
  plan.audioLangs.forEach((_, i) => mkdirSync(path.join(dir, String(i)), { recursive: true }));

  const ext = plan.segmentType === "fmp4" ? "m4s" : "ts";
  writeFileSync(path.join(dir, "master.m3u8"), buildMasterPlaylist(plan));
  writeFileSync(path.join(dir, "v", "playlist.m3u8"), variantPlaylist(segmentCount(plan), ext));
  plan.audioLangs.forEach((_, i) =>
    writeFileSync(path.join(dir, String(i), "playlist.m3u8"), variantPlaylist(segmentCount(plan), "ts")),
  );

  const total = segmentCount(plan);
  const videoRunner: RunnerState = { proc: null, fromSeg: -1, toSeg: -1 };
  const audioRunners: RunnerState[] = plan.audioLangs.map(() => ({ proc: null, fromSeg: -1, toSeg: -1 }));

  // Ensure segment `segIndex` is inside the window a runner is producing.
  // Starts/re-anchors a runner when none is active or the request falls
  // outside the current window.
  function ensureWindow(state: RunnerState, segIndex: number, spawnFn: (from: number, to: number) => ChildProcess): void {
    if (segIndex >= total) return;
    const inWindow = state.proc !== null && segIndex >= state.fromSeg && segIndex < state.toSeg;
    if (inWindow) return;
    if (state.proc) {
      state.proc.kill("SIGKILL");
      state.proc = null;
    }
    const fromSeg = Math.max(0, segIndex);
    const toSeg = Math.min(total, fromSeg + RUN_SEGMENT_COUNT);
    state.proc = spawnFn(fromSeg, toSeg);
    state.fromSeg = fromSeg;
    state.toSeg = toSeg;
    state.proc.on("exit", () => {
      // Natural window completion: clear so the next request re-anchors.
      if (state.proc && state.proc.exitCode !== null && state.proc.exitCode !== undefined) state.proc = null;
    });
  }

  // Kick off encoding from the plan's start position immediately.
  ensureWindow(videoRunner, 0, (a, b) => spawnRunner(plan, dir, a, b));
  audioRunners.forEach((state, track) => {
    ensureWindow(state, 0, (a, b) => spawnAudioRunner(plan, dir, track, a, b));
  });

  const port = await freePort();
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "").split("?")[0] ?? "").replace(/^\/+/, "");
    // Pre-written playlists.
    if (name === "master.m3u8" || name.endsWith("/playlist.m3u8")) {
      const file = path.join(dir, name);
      if (!existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(readFileSync(file, "utf8"));
      return;
    }
    // Segments: serve if present; else re-anchor the runner at this position
    // and poll briefly for the file (the receiver tolerates short delays).
    const m = name.match(/^(v|\d+)\/seg(\d+)\.(ts|m4s)$/);
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    const variant = m[1]!;
    const segIndex = Number(m[2]);
    if (segIndex >= total) {
      res.writeHead(404).end();
      return;
    }
    const file = path.join(dir, variant, `seg${segIndex}.ts`);
    const respond = (): void => {
      if (existsSync(file)) {
        serveFile(res, file, "video/mp2t");
        reportProgress(dir, plan, onProgress);
      } else {
        res.writeHead(502).end();
      }
    };
    if (existsSync(file)) {
      respond();
      return;
    }
    // Seek into unwritten territory: re-anchor the runner(s) here.
    if (variant === "v") {
      ensureWindow(videoRunner, segIndex, (a, b) => spawnRunner(plan, dir, a, b));
    } else {
      const track = Number(variant);
      const state = audioRunners[track];
      if (state) ensureWindow(state, segIndex, (a, b) => spawnAudioRunner(plan, dir, track, a, b));
    }
    // Poll for the segment (runners produce it within a couple of seconds).
    let waited = 0;
    const poll = setInterval(() => {
      waited += 250;
      if (existsSync(file)) {
        clearInterval(poll);
        respond();
      } else if (waited > 20000) {
        clearInterval(poll);
        res.writeHead(502).end();
      }
    }, 250);
    req.on("close", () => clearInterval(poll));
  });
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));

  return {
    url: `http://${lanIp}:${port}/master.m3u8`,
    dir,
    stop: () => {
      videoRunner.proc?.kill("SIGKILL");
      audioRunners.forEach((s) => s.proc?.kill("SIGKILL"));
      server.close();
    },
  };
}
