import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";

// On-demand HLS transcode server for AirPlay casting.
//
// Writes a complete VOD playlist upfront — the receiver gets a normal VOD with
// a full scrub bar and native seeking — and transcodes each 2s segment the
// first time the receiver requests it (mpv-style, same idea as hls-vod-too).
// Only watched content is ever computed; a seek costs ~0.5s of ffmpeg.

export interface SegmentPlan {
  sourceUrl: string;
  durationSec: number;
  audioLangs: string[];
  video: "copy" | "encode";
  startSec: number;
}

const SEGMENT_SEC = 2;

export function segmentCount(plan: SegmentPlan): number {
  return Math.max(1, Math.ceil((plan.durationSec - plan.startSec) / SEGMENT_SEC));
}

// Playlist for one variant: every segment declared, VOD-terminated. Segment
// files are named seg<N>.ts and may not exist yet — the server generates them
// on request.
function variantPlaylist(count: number): string {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${SEGMENT_SEC}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  for (let i = 0; i < count; i++) {
    lines.push("#EXTINF:2.000000,", `seg${i}.ts`);
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
  lines.push('#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"');
  lines.push("v/playlist.m3u8");
  return lines.join("\n") + "\n";
}

// ffmpeg command for one segment of one variant. Video re-encodes (veryfast)
// so every segment starts on a keyframe and matches the declared 2s grid —
// stream copy would drift against the playlist timeline and desync late in
// the file. ~0.5s wall time per segment.
function segmentFfmpegArgs(plan: SegmentPlan, variant: "v" | number, segIndex: number, outFile: string): string[] {
  const start = plan.startSec + segIndex * SEGMENT_SEC;
  const args = ["-y", "-ss", start.toFixed(3), "-i", plan.sourceUrl, "-t", String(SEGMENT_SEC)];
  if (variant === "v") {
    args.push("-map", "0:v:0", "-c:v", "libx264", "-preset", "veryfast");
  } else {
    args.push("-map", `0:a:${variant}`, "-vn");
  }
  args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  return args;
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

// Segment generation is serialized globally: the receiver requests segments in
// bursts (play + pre-fetch) and parallel ffmpeg spawns would thrash the
// torrent's piece cache. Concurrent requests for the same segment share one
// promise.
let generationQueue: Promise<unknown> = Promise.resolve();

function generateSegment(plan: SegmentPlan, dir: string, variant: string, segIndex: number): Promise<void> {
  const file = path.join(dir, variant, `seg${segIndex}.ts`);
  if (existsSync(file)) return Promise.resolve();
  const run = generationQueue.then(
    () =>
      new Promise<void>((resolve, reject) => {
        if (existsSync(file)) return resolve();
        mkdirSync(path.join(dir, variant), { recursive: true });
        const args = segmentFfmpegArgs(plan, variant === "v" ? "v" : Number(variant), segIndex, file);
        const ff = spawn("ffmpeg", [...args, file], { stdio: "ignore" });
        ff.on("error", reject);
        ff.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg seg ${variant}/${segIndex} exited ${code}`))));
      }),
  );
  generationQueue = run.catch(() => {}); // keep the queue alive on failures
  return run;
}

function reportProgress(dir: string, plan: SegmentPlan, onProgress?: (pct: number) => void): void {
  if (!onProgress) return;
  try {
    const count = readdirSync(path.join(dir, "v")).filter((f) => f.endsWith(".ts")).length;
    onProgress(Math.min(99, Math.round((count / segmentCount(plan)) * 100)));
  } catch {}
}

function serveFile(res: http.ServerResponse, file: string): void {
  res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": statSync(file).size });
  createReadStream(file).pipe(res);
}

// Start the server. Returns the master playlist URL (with the given host IP)
// and a stop function that closes the HTTP server; generated segments stay on
// disk until the caller removes the directory.
export async function startOnDemandServer(
  plan: SegmentPlan,
  lanIp: string,
  onProgress?: (pct: number) => void,
): Promise<{ url: string; dir: string; stop: () => void }> {
  const dir = path.join(tmpdir(), `torlnk-cast-${Date.now()}`);
  mkdirSync(path.join(dir, "v"), { recursive: true });
  plan.audioLangs.forEach((_, i) => mkdirSync(path.join(dir, String(i)), { recursive: true }));

  writeFileSync(path.join(dir, "master.m3u8"), buildMasterPlaylist(plan));
  writeFileSync(path.join(dir, "v", "playlist.m3u8"), variantPlaylist(segmentCount(plan)));
  plan.audioLangs.forEach((_, i) =>
    writeFileSync(path.join(dir, String(i), "playlist.m3u8"), variantPlaylist(segmentCount(plan))),
  );

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
    // Segments: serve if present, else generate then serve.
    const m = name.match(/^(v|\d+)\/seg(\d+)\.ts$/);
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    const variant = m[1]!;
    const segIndex = Number(m[2]);
    if (segIndex >= segmentCount(plan)) {
      res.writeHead(404).end();
      return;
    }
    const file = path.join(dir, variant, `seg${segIndex}.ts`);
    if (existsSync(file)) {
      serveFile(res, file);
      return;
    }
    generateSegment(plan, dir, variant, segIndex)
      .then(() => {
        serveFile(res, file);
        reportProgress(dir, plan, onProgress);
      })
      .catch(() => res.writeHead(502).end());
  });
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));

  return {
    url: `http://${lanIp}:${port}/master.m3u8`,
    dir,
    stop: () => server.close(),
  };
}
