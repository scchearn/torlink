import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { airplayPlan, buildVarStreamMap, capsForDevice, findHelperScript } from "./players.js";

const ATV_HD = capsForDevice("airplay", "DeviceModel.Gen4");
const ATV_4K = capsForDevice("airplay", "DeviceModel.Gen4K");

// Copyable audio: AAC-LC, sane rate, HLS-compatible channel count.
const AAC = { codec: "aac", profile: "LC", sampleRate: 48000, channels: 2 };
const DDP = { codec: "eac3", profile: null, sampleRate: 48000, channels: 6 };
const HE_AAC = { codec: "aac", profile: "HE-AAC", sampleRate: 48000, channels: 2 };

describe("airplayPlan", () => {
  it("direct for tvOS-native containers regardless of codec", () => {
    expect(airplayPlan("http://x/video.mp4", "mpeg2video", null, ATV_HD, AAC)).toEqual({ mode: "direct" });
    expect(airplayPlan("/tmp/movie.M4V", null, null, ATV_HD, AAC)).toEqual({ mode: "direct" });
  });

  it("remux (copy) when the target decodes the source natively AND the audio is copyable", () => {
    expect(airplayPlan("http://x/movie.mkv", "h264", "yuv420p", ATV_HD, AAC)).toEqual({
      mode: "transcode", video: "copy", pixFmt: "copy",
    });
  });

  it("encodes video when the audio would need transcoding — copy+transcode desyncs per-window", () => {
    // DDP5.1 / HE-AAC audio can't ride along; video copy would desync by up to
    // a GOP on every seek (measured 2.2s on a real rip).
    expect(airplayPlan("http://x/movie.mkv", "h264", "yuv420p", ATV_HD, DDP)).toEqual({
      mode: "transcode", video: "encode", pixFmt: "copy",
    });
    expect(airplayPlan("http://x/movie.mkv", "h264", "yuv420p", ATV_HD, HE_AAC)).toEqual({
      mode: "transcode", video: "encode", pixFmt: "copy",
    });
    // Unknown audio: assume not copyable, encode.
    expect(airplayPlan("http://x/movie.mkv", "h264", "yuv420p", ATV_HD, null)).toEqual({
      mode: "transcode", video: "encode", pixFmt: "copy",
    });
  });

  it("re-encodes hevc for 8-bit-only targets but copies for HEVC-capable ones with copyable audio", () => {
    expect(airplayPlan("http://x/movie.mkv", "hevc", "yuv420p10le", ATV_HD, AAC)).toEqual({
      mode: "transcode", video: "encode", pixFmt: "yuv420p",
    });
    expect(airplayPlan("http://x/movie.mkv", "hevc", "yuv420p10le", ATV_4K, AAC)).toEqual({
      mode: "transcode", video: "copy", pixFmt: "copy",
    });
    // HEVC copy also requires copyable audio.
    expect(airplayPlan("http://x/movie.mkv", "hevc", "yuv420p10le", ATV_4K, DDP)).toEqual({
      mode: "transcode", video: "encode", pixFmt: "copy",
    });
  });

  it("downconverts 10-bit h264 on 8-bit-only targets, copies on capable ones", () => {
    expect(airplayPlan("http://x/anime.mkv", "h264", "yuv420p10le", ATV_HD, AAC)).toEqual({
      mode: "transcode", video: "encode", pixFmt: "yuv420p",
    });
    expect(airplayPlan("http://x/anime.mkv", "h264", "yuv420p10le", ATV_4K, AAC)).toEqual({
      mode: "transcode", video: "copy", pixFmt: "copy",
    });
  });

  it("re-encodes foreign codecs (vp9/av1/mpeg2) regardless of target", () => {
    expect(airplayPlan("http://x/movie.mkv", "vp9", "yuv420p", ATV_4K, AAC)).toEqual({
      mode: "transcode", video: "encode", pixFmt: "copy",
    });
  });

  it("direct when probe fails (best effort)", () => {
    expect(airplayPlan("http://x/movie.mkv", null, null, ATV_HD, AAC)).toEqual({ mode: "direct" });
  });
});

describe("capsForDevice", () => {
  it("maps known Apple TV models", () => {
    expect(capsForDevice("airplay", "DeviceModel.Gen4").canHevc).toBe(false);
    expect(capsForDevice("airplay", "DeviceModel.Gen4K").canHevc).toBe(true);
    expect(capsForDevice("airplay", "DeviceModel.Gen4K").segmentType).toBe("fmp4");
  });

  it("honors the TORLINK_CAST_PROFILE override", () => {
    process.env.TORLINK_CAST_PROFILE = "high";
    expect(capsForDevice("airplay", "DeviceModel.Gen4").canHevc).toBe(true);
    process.env.TORLINK_CAST_PROFILE = "low";
    expect(capsForDevice("airplay", "DeviceModel.Gen4K").canHevc).toBe(false);
    delete process.env.TORLINK_CAST_PROFILE;
  });

  it("defaults to conservative h264-only caps for chromecast (gen2/3 most common)", () => {
    expect(capsForDevice("chromecast", "").canHevc).toBe(false);
    expect(capsForDevice("chromecast", "").segmentType).toBe("mpegts");
  });

  it("TORLINK_CAST_PROFILE=high grants chromecast HEVC via fmp4", () => {
    process.env.TORLINK_CAST_PROFILE = "high";
    expect(capsForDevice("chromecast", "").canHevc).toBe(true);
    expect(capsForDevice("chromecast", "").segmentType).toBe("fmp4");
    delete process.env.TORLINK_CAST_PROFILE;
  });
});

describe("buildVarStreamMap", () => {
  it("defaults to the first track, passing language tags through", () => {
    const { map, defaultIdx } = buildVarStreamMap(["fre", "eng"]);
    expect(defaultIdx).toBe(0);
    expect(map).toContain("a:0,agroup:aud,language:FRE,default:YES");
    expect(map).toContain("a:1,agroup:aud,language:ENG,default:NO");
    expect(map).toContain("v:0,agroup:aud");
  });

  it("defaults to track 0 when no language tags exist", () => {
    const { map, defaultIdx } = buildVarStreamMap(["", ""]);
    expect(defaultIdx).toBe(0);
    expect(map).toContain("a:0,agroup:aud,default:YES");
    expect(map).not.toContain("language:");
  });

  it("handles a single audio track", () => {
    const { map, defaultIdx } = buildVarStreamMap(["jpn"]);
    expect(defaultIdx).toBe(0);
    expect(map).toBe("a:0,agroup:aud,language:JPN,default:YES v:0,agroup:aud");
  });
});

describe("findHelperScript", () => {
  it("locates the airplay helper script from the module location", () => {
    expect(existsSync(findHelperScript())).toBe(true);
  });
});
