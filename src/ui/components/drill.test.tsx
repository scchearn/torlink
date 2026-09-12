import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreContext, type Section } from "../store";
import { makeTestStore, renderUI } from "../testHarness";
import { Results } from "./Results";

vi.mock("../../sources/skwirll", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sources/skwirll")>();
  return {
    ...actual,
    browseTitles: vi.fn(async () => [
      { imdb: "tt1", title: "Mutiny 2026", seeders: 5274 },
      { imdb: "tt2", title: "Coraline 2009", seeders: 272 },
    ]),
  };
});

let ui: ReturnType<typeof renderUI> | null = null;
afterEach(() => {
  ui?.unmount();
  ui = null;
});

// Regression guard for the drill-down escape: the drill-down's own query and
// section changes must not reset the drilled flag (drillingRef latch), and
// list mode with drilled must capture esc (captureMode "esc") so App's
// focus-to-sidebar escape doesn't swallow the keypress.
describe("drill-down esc", () => {
  it("enter on a title drills in; esc walks back to the title list", async () => {
    const calls: { query: string[]; sections: Section[] } = { query: [], sections: [] };
    const store = makeTestStore({ section: "new", query: "" });
    store.submitQuery = (q: string) => {
      calls.query.push(q);
      store.query = q;
    };
    store.setSection = (s: Section) => {
      calls.sections.push(s);
      store.section = s;
    };
    ui = renderUI(
      <StoreContext.Provider value={store}>
        <Results />
      </StoreContext.Provider>,
    );
    await vi.waitFor(() => expect(ui!.frame()).toContain("new releases this week"));
    ui.press("\r"); // enter on the first title
    await vi.waitFor(() => expect(calls.query).toContain("Mutiny 2026"));
    expect(calls.sections).toContain("movies");
    ui.press("\u001b"); // esc walks back
    await vi.waitFor(() => {
      expect(calls.query[calls.query.length - 1]).toBe("");
      expect(calls.sections[calls.sections.length - 1]).toBe("new");
    });
  });
});
