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
    lines.push("#EXTINF:2.000000,", `seg${String(i).padStart(3, "0")}.${ext}`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

export function buildMasterPlaylist(plan: SegmentPlan): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  // Variant dirs mirror the runner's var_stream_map order: video = "0",
  // audio track i = "i+1".
  plan.audioLangs.forEach((lang, i) => {
    const tag = lang ? `,LANGUAGE="${lang.toUpperCase().slice(0, 3)}"` : "";
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio_${i}"${tag},DEFAULT=${i === 0 ? "YES" : "NO"},CHANNELS="2",URI="${i + 1}/pl.m3u8"`,
    );
  });
  // HEVC copy requires hvc1 in CODECS; h264 re-encode matches the runner's
  // output (High@4.0). Audio is always AAC-LC stereo.
  const vcodec = plan.video === "copy" && plan.sourceHevc ? "hvc1.1.6.L120.90" : "avc1.640028";
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="${vcodec},mp4a.40.2",AUDIO="aud"`);
  lines.push("0/pl.m3u8");
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

// One continuous ffmpeg encode per window, video AND all audio tracks in the
// SAME process — this is what keeps A/V sample-locked. Separate per-stream
// runners each do their own -ss anchor and drift apart by up to a frame at
// every segment boundary (measured 72ms audio-lead on a DDP5.1 source); a
// combined encode anchors once and shares one demuxer clock (measured ≤16ms,
// inaudible). Segments [fromSeg, toSeg), cut at exact 2s boundaries; exits on
// its own at the window end.
//
// Audio sync is maintained by aresample=async=1000:first_pts=0: our CFR grid
// (fps=24) never exactly matches movie sources (23.976fps = 0.1% timeline
// mismatch ≈ 0.1s drift per 100s). async=1 only corrects via hard
// fill/trim gated at 100ms (libswresample min_hard_comp) — audible hiccups
// that grow before each correction. async=1000 instead stretches/squeezes
// continuously at ≤ ~21ms/sec, inaudible, and first_pts=0 keeps the window
// head on the segment grid.
//
// Variant layout: ffmpeg numbers variants in var_stream_map order — video
// first (dir "0"), then audio track i (dir "i+1"). The master playlist and
// the server's request routing use the same mapping.
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
    ...plan.audioLangs.map((_, i) => ["-map", `0:a:${i}`]).flat(),
  ];
  if (copy) {
    // Stream copy: no filters (filters require re-encode). Keyframe-aligned
    // cutting relies on the source's own GOP; segment boundaries may drift
    // slightly from the 2s grid — copy mode is only granted for well-formed
    // sources, so this is acceptable.
    args.push("-c:v", "copy");
  } else {
    args.push("-vf", `${filters.join(",")},setpts=PTS-STARTPTS`);
    args.push("-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SEC})`);
    args.push("-c:v", "libx264", "-preset", "veryfast");
  }
  args.push("-af", "aresample=async=1000:first_pts=0");
  args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  const ext = plan.segmentType === "fmp4" ? "m4s" : "ts";
  args.push(
    "-f", "hls",
    "-hls_time", String(SEGMENT_SEC),
    "-hls_list_size", "0",
    "-hls_segment_type", plan.segmentType,
    "-hls_playlist_type", "vod",
    "-master_pl_name", "runner.m3u8",
    "-var_stream_map",
    [
      // Video first: variant 0 = video (served from dir "0"), audio track i
      // = variant i+1 (dir "i+1"). ffmpeg numbers variants in map order.
      "v:0,agroup:aud0",
      ...plan.audioLangs.map((_, i) => `a:${i},agroup:aud0`),
    ].join(" "),
    "-hls_segment_filename", path.join(dir, "%v", `seg%03d.${ext}`),
    "-start_number", String(fromSeg),
    // The runner's own per-variant playlist goes to a throwaway name — the
    // server serves the authoritative full-length playlist instead.
    path.join(dir, "%v", "runner-pl.m3u8"),
  );
  return spawn("ffmpeg", args, { stdio: "ignore" });
}

function reportProgress(dir: string, plan: SegmentPlan, onProgress?: (pct: number) => void): void {
  if (!onProgress) return;
  try {
    // Video variant is dir "0" (see variant layout).
    const count = readdirSync(path.join(dir, "0")).filter((f) => f.endsWith(".ts") || f.endsWith(".m4s")).length;
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
  // Variant dirs mirror the runner's var_stream_map order: video = "0",
  // audio track i = "i+1".
  mkdirSync(path.join(dir, "0"), { recursive: true });
  plan.audioLangs.forEach((_, i) => mkdirSync(path.join(dir, String(i + 1)), { recursive: true }));

  const ext = plan.segmentType === "fmp4" ? "m4s" : "ts";
  // master.m3u8 and the full-length per-variant playlists are pre-written;
  // the runner only produces segment files (its own playlist output goes to
  // runner-pl.m3u8, unused).
  writeFileSync(path.join(dir, "master.m3u8"), buildMasterPlaylist(plan));
  writeFileSync(path.join(dir, "0", "pl.m3u8"), variantPlaylist(segmentCount(plan), ext));
  plan.audioLangs.forEach((_, i) =>
    writeFileSync(path.join(dir, String(i + 1), "pl.m3u8"), variantPlaylist(segmentCount(plan), "ts")),
  );

  const total = segmentCount(plan);
  const runner: RunnerState = { proc: null, fromSeg: -1, toSeg: -1 };

  // Ensure segment `segIndex` is inside the window the runner is producing.
  // Re-anchors when none is active or the request falls outside the window.
  function ensureWindow(segIndex: number): void {
    if (segIndex >= total) return;
    const inWindow = runner.proc !== null && segIndex >= runner.fromSeg && segIndex < runner.toSeg;
    if (inWindow) return;
    if (runner.proc) {
      runner.proc.kill("SIGKILL");
      runner.proc = null;
    }
    const fromSeg = Math.max(0, segIndex);
    const toSeg = Math.min(total, fromSeg + RUN_SEGMENT_COUNT);
    runner.proc = spawnRunner(plan, dir, fromSeg, toSeg);
    runner.fromSeg = fromSeg;
    runner.toSeg = toSeg;
    runner.proc.on("exit", () => {
      // Natural window completion: clear so the next request re-anchors.
      if (runner.proc && runner.proc.exitCode !== null && runner.proc.exitCode !== undefined) runner.proc = null;
    });
  }

  // Kick off encoding from the plan's start position immediately.
  ensureWindow(0);

  const port = await freePort();
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "").split("?")[0] ?? "").replace(/^\/+/, "");
    // Pre-written playlists.
    if (name === "master.m3u8" || name.endsWith("/pl.m3u8")) {
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
    const ext = plan.segmentType === "fmp4" ? "m4s" : "ts";
    const file = path.join(dir, variant, `seg${String(segIndex).padStart(3, "0")}.${ext}`);
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
    // Seek into unwritten territory: re-anchor the runner here.
    ensureWindow(segIndex);
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
      runner.proc?.kill("SIGKILL");
      server.close();
    },
  };
}
