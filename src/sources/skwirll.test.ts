import { describe, expect, it } from "vitest";
import { _internals } from "./skwirll";

const { readableName, DUB_MARKERS } = _internals;

describe("readableName", () => {
  it("strips quality/codec markers and release groups", () => {
    expect(readableName("Go.Team.2026.1080p.WEB.h264-GRACE")).toBe("Go Team 2026");
    expect(readableName("Leviticus.2026.1080p.BluRay.x264-Replica")).toBe("Leviticus 2026");
  });

  it("keeps the title when nothing matches", () => {
    expect(readableName("Some.Movie")).toBe("Some Movie");
  });
});

describe("DUB_MARKERS", () => {
  it("flags dubs and localizations", () => {
    expect(DUB_MARKERS.test("Das.Kartell.2026.GERMAN.1080p.WEB.H264-MGE")).toBe(true);
    expect(DUB_MARKERS.test("Call.My.Agent.The.Movie.2026.POLISH.1080p.WEB.H264-FLAME")).toBe(true);
    expect(DUB_MARKERS.test("Go.Team.2026.1080p.WEB.h264-GRACE")).toBe(false);
  });
});

describe("scene-name fallback cleaner", () => {
  it("strips PAL/DVD9/COMPLETE artifacts and language tags", () => {
    expect(_internals.readableName("Bruder.vor.Luder.2015.GERMAN.COMPLETE.PAL.DVD9-iNRi")).toBe(
      "Bruder vor Luder 2015",
    );
    expect(_internals.readableName("Vaiana.2026.German.DL.2160p.WEB.h265-DEEP")).toBe("Vaiana 2026");
  });
});
