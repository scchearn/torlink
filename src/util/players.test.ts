import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { airplayPlan, buildVarStreamMap, capsForDevice, findHelperScript } from "./players.js";

const ATV_HD = capsForDevice("airplay", "DeviceModel.Gen4");
const ATV_4K = capsForDevice("airplay", "DeviceModel.Gen4K");

describe("airplayPlan", () => {
  it("direct for tvOS-native containers regardless of codec", () => {
    expect(airplayPlan("http://x/video.mp4", "mpeg2video", null, ATV_HD)).toEqual({ mode: "direct" });
    expect(airplayPlan("/tmp/movie.M4V", null, null, ATV_HD)).toEqual({ mode: "direct" });
  });

  it("remux (copy) when the target decodes the source natively", () => {
    expect(airplayPlan("http://x/movie.mkv", "h264", "yuv420p", ATV_HD)).toEqual({
      mode: "transcode", video: "copy", pixFmt: "copy",
    });
  });

  it("re-encodes hevc for 8-bit-only targets but copies for HEVC-capable ones", () => {
    expect(airplayPlan("http://x/movie.mkv", "hevc", "yuv420p10le", ATV_HD)).toEqual({
      mode: "transcode", video: "encode", pixFmt: "yuv420p",
    });
    expect(airplayPlan("http://x/movie.mkv", "hevc", "yuv420p10le", ATV_4K)).toEqual({
      mode: "transcode", video: "copy", pixFmt: "copy",
    });
  });

  it("downconverts 10-bit h264 on 8-bit-only targets, copies on capable ones", () => {
    expect(airplayPlan("http://x/anime.mkv", "h264", "yuv420p10le", ATV_HD)).toEqual({
      mode: "transcode", video: "encode", pixFmt: "yuv420p",
    });
    expect(airplayPlan("http://x/anime.mkv", "h264", "yuv420p10le", ATV_4K)).toEqual({
      mode: "transcode", video: "copy", pixFmt: "copy",
    });
  });

  it("re-encodes foreign codecs (vp9/av1/mpeg2) regardless of target", () => {
    expect(airplayPlan("http://x/movie.mkv", "vp9", "yuv420p", ATV_4K)).toEqual({
      mode: "transcode", video: "encode", pixFmt: "copy",
    });
  });

  it("direct when probe fails (best effort)", () => {
    expect(airplayPlan("http://x/movie.mkv", null, null, ATV_HD)).toEqual({ mode: "direct" });
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
