import { afterEach, describe, expect, it, vi } from "vitest";
import { readBoardViewport, validBoardViewport, writeBoardViewport } from "./board-viewport";
import { revealDelta } from "./canvas-layout";

afterEach(() => vi.unstubAllGlobals());

describe("remembering a board view", () => {
  it.each([null, {}, { x: 1, y: 2, zoom: 0 }, { x: 1, y: 2, zoom: 7 },
    { x: Infinity, y: 2, zoom: 1 }, { x: 1, y: NaN, zoom: 1 }, { x: "1", y: 2, zoom: 1 }])(
    "rejects invalid cached coordinates: %j", value => expect(validBoardViewport(value)).toBeNull(),
  );
  it("keeps each account/board/epoch key separate", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
    writeBoardViewport("user-a:board:epoch-1", { x: -120, y: 800, zoom: 1.5 });
    expect(readBoardViewport("user-a:board:epoch-1")).toEqual({ x: -120, y: 800, zoom: 1.5 });
    expect(readBoardViewport("user-b:board:epoch-1")).toBeNull();
    expect(readBoardViewport("user-a:board:epoch-2")).toBeNull();
    storage.set("corrupt", "not json");
    expect(readBoardViewport("corrupt")).toBeNull();
  });
  it("keeps navigation usable when device storage is blocked", () => {
    vi.stubGlobal("localStorage", { getItem() { throw Error("Blocked"); }, setItem() { throw Error("Full"); } });
    expect(readBoardViewport("board")).toBeNull();
    expect(() => writeBoardViewport("board", { x: 0, y: 0, zoom: 1 })).not.toThrow();
  });
});

describe("revealing a quick-created note", () => {
  const padding: [number, number, number, number] = [96, 88, 80, 88];
  it("leaves an already visible note in place", () => {
    expect(revealDelta({ x: 200, y: 200, w: 208, h: 208 }, 1000, 800, padding)).toEqual({ x: 0, y: 0 });
  });
  it("pans only far enough to clear floating controls", () => {
    expect(revealDelta({ x: 850, y: 650, w: 208, h: 208 }, 1000, 800, padding)).toEqual({ x: 146, y: 138 });
    expect(revealDelta({ x: 20, y: 40, w: 208, h: 208 }, 1000, 800, padding)).toEqual({ x: -68, y: -56 });
  });
  it("centers an oversized note rather than endlessly panning between its edges", () => {
    expect(revealDelta({ x: 0, y: 0, w: 1200, h: 1000 }, 1000, 800, padding)).toEqual({ x: 100, y: 92 });
  });
});
