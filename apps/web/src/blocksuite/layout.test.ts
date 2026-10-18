import { describe, expect, it } from "vitest";
import {
  arrangeBoxes,
  findOpenPosition,
  connectedPosition,
  canArrange,
  readingOrder,
  connectorEndPorts,
  facingPorts,
  nextNotePlacement,
  duplicatePlacement,
  CONNECTION_PORTS,
} from "./layout";

describe("quick note placement", () => {
  it("keeps a free position and moves past a chain of obstructing objects", () => {
    const desired = { id: "new", x: 300, y: 0, w: 208, h: 208 };
    const blockers = [
      { id: "first", x: 304, y: 0, w: 208, h: 208 },
      { id: "second", x: 304, y: 240, w: 208, h: 208 },
      { id: "unrelated", x: 900, y: 0, w: 208, h: 800 },
    ];
    expect(findOpenPosition(desired, [])).toEqual(desired);
    expect(findOpenPosition(desired, blockers)).toEqual({ ...desired, y: 480 });
    expect(desired.y).toBe(0);
  });
});

describe("selection arrangement", () => {
  const boxes = [
    { id: "a", x: 10, y: 30, w: 80, h: 50 },
    { id: "b", x: 180, y: 10, w: 120, h: 70 },
    { id: "c", x: 400, y: 120, w: 60, h: 90 },
  ];
  it("aligns different-sized objects to their shared right edge without mutating input", () => {
    const result = arrangeBoxes(boxes, "right");
    expect(result.map((b) => b.x + b.w)).toEqual([460, 460, 460]);
    expect(result.map((b) => b.y)).toEqual([30, 10, 120]);
    expect(boxes[0].x).toBe(10);
  });
  it("distributes by equal edge gaps while retaining the two outside objects", () => {
    const result = arrangeBoxes(boxes, "horizontal");
    expect(result[0].x).toBe(10);
    expect(result[2].x).toBe(400);
    expect(result[1].x - result[0].x - result[0].w).toBe(
      result[2].x - result[1].x - result[1].w,
    );
  });
  it("orders a tidy grid in reading order (a, b share a row) and leaves room for the largest object", () => {
    const result = arrangeBoxes(boxes, "grid");
    expect(result.map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(result[1].x - result[0].x).toBe(152);
    expect(result[2].y - result[0].y).toBe(122);
  });
  it("does not attempt distribution with only two objects", () => {
    expect(arrangeBoxes(boxes.slice(0, 2), "vertical")).toEqual(
      boxes.slice(0, 2),
    );
  });
});

describe("connected branch placement", () => {
  const source = { id: "s", x: 500, y: 500, w: 160, h: 240 };
  it("centers a square branch on a tall source with the same edge gap in every direction", () => {
    const size = { w: 160, h: 160 };
    expect(connectedPosition(source, "right", [], size)).toEqual({ id: "new", x: 756, y: 540, ...size });
    expect(connectedPosition(source, "left", [], size)).toEqual({ id: "new", x: 244, y: 540, ...size });
    expect(connectedPosition(source, "up", [], size)).toEqual({ id: "new", x: 500, y: 244, ...size });
    expect(connectedPosition(source, "down", [], size)).toEqual({ id: "new", x: 500, y: 836, ...size });
  });
  it("checks collisions against the new square rather than the shorter source", () => {
    const short = { ...source, w: 420, h: 140 };
    const obstacle = { id: "o", x: 1016, y: 700, w: 200, h: 100 };
    const next = connectedPosition(short, "right", [obstacle], { w: 420, h: 420 });
    expect(next).toEqual({ id: "new", x: 1016, y: 832, w: 420, h: 420 });
    const adjacent = findOpenPosition({ ...short, x: 952, h: short.w }, [obstacle]);
    expect(adjacent.y).toBe(832);
  });
  it("keeps dimensions and points outward in all four directions", () => {
    expect(connectedPosition(source, "left", []).x).toBe(244);
    expect(connectedPosition(source, "right", []).x).toBe(756);
    expect(connectedPosition(source, "up", []).y).toBe(164);
    expect(connectedPosition(source, "down", []).y).toBe(836);
    for (const ports of Object.values(CONNECTION_PORTS)) {
      expect(ports.source[0] + ports.target[0]).toBe(1);
      expect(ports.source[1] + ports.target[1]).toBe(1);
    }
  });
  it("moves an upward branch sideways to avoid a chain without crossing below its source", () => {
    const obstacle = { id: "a", x: 500, y: 164, w: 160, h: 240 };
    const next = connectedPosition(source, "up", [
      source,
      obstacle,
      { ...obstacle, id: "b", x: 692 },
    ]);
    expect(next.y).toBe(164);
    expect(next.x).toBe(884);
    expect(next.w).toBe(160);
    expect(next.h).toBe(240);
    expect(source.x).toBe(500);
  });
});

describe("arrange eligibility", () => {
  it("allows notes and shapes inside frames", () => {
    expect(canArrange({ kind: "note", locked: false, inGroup: false })).toBe(true);
    expect(canArrange({ kind: "shape", locked: false, inGroup: false })).toBe(true);
  });
  it("keeps locked objects, group members, connectors and containers in place", () => {
    expect(canArrange({ kind: "note", locked: true, inGroup: false })).toBe(false);
    expect(canArrange({ kind: "note", locked: false, inGroup: true })).toBe(false);
    for (const kind of ["connector", "frame", "group", "mindmap"])
      expect(canArrange({ kind, locked: false, inGroup: false })).toBe(false);
  });
});

describe("keyboard reading order", () => {
  it("reads rows top to bottom and left to right, tolerating uneven rows", () => {
    const box = (id: string, x: number, y: number) => ({ id, x, y, w: 200, h: 200 });
    const order = readingOrder([box("c", 500, 30), box("a", 0, 0), box("d", 0, 300), box("b", 250, -20)]);
    expect(order.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("is stable for identical positions", () => {
    const same = [{ id: "b", x: 0, y: 0, w: 10, h: 10 }, { id: "a", x: 0, y: 0, w: 10, h: 10 }];
    expect(readingOrder(same).map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("connector ports between two objects", () => {
  const box = (x: number, y: number, w = 200, h = 200) => ({ x, y, w, h });
  it("joins side by side objects on their facing sides", () => {
    expect(facingPorts(box(0, 0), box(500, 0))).toEqual({ source: [1, 0.5], target: [0, 0.5] });
    expect(facingPorts(box(500, 40), box(0, 0))).toEqual({ source: [0, 0.5], target: [1, 0.5] });
  });
  it("joins stacked objects top to bottom", () => {
    expect(facingPorts(box(0, 0), box(30, 400))).toEqual({ source: [0.5, 1], target: [0.5, 0] });
    expect(facingPorts(box(0, 400), box(0, 0))).toEqual({ source: [0.5, 0], target: [0.5, 1] });
  });
  it("weighs distance by object size", () => {
    // A wide banner just below a note is below it, not beside it.
    expect(facingPorts(box(0, 0, 200, 100), box(-300, 160, 900, 80)).source).toEqual([0.5, 1]);
  });
});

describe("tidy into a grid", () => {
  it("keeps a rough row as one row, in reading order", () => {
    const boxes = [{ id: "A", x: 0, y: 10, w: 200, h: 200 }, { id: "B", x: 260, y: 0, w: 200, h: 200 }, { id: "C", x: 520, y: 30, w: 200, h: 200 }];
    const tidy = arrangeBoxes(boxes, "grid");
    expect(tidy.map((box) => box.id)).toEqual(["A", "B", "C"]);
    expect(new Set(tidy.map((box) => box.y)).size).toBe(1);
  });
  it("wraps scattered objects into a square grid in reading order", () => {
    const boxes = [
      { id: "C", x: 0, y: 600, w: 100, h: 100 }, { id: "A", x: 0, y: 0, w: 100, h: 100 },
      { id: "B", x: 400, y: 20, w: 100, h: 100 }, { id: "D", x: 300, y: 900, w: 100, h: 100 },
    ];
    expect(arrangeBoxes(boxes, "grid").map((box) => box.id)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("next note placement", () => {
  const note = (id: string, x: number, y: number) => ({ id, x, y, w: 200, h: 200 });
  it("goes right of the source, clear of objects and other frames", () => {
    const { box, frameHeight } = nextNotePlacement(note("a", 0, 0), [note("b", 232, 0)], [{ id: "f2", x: 500, y: -40, w: 400, h: 400 }], null);
    expect(box.x).toBe(232);
    expect(box.y).toBe(232);
    expect(frameHeight).toBeNull();
  });
  it("wraps to the next row inside a full frame and grows the frame", () => {
    const frame = { id: "f", x: -24, y: -60, w: 700, h: 300 };
    const notes = [note("a", 0, 0), note("b", 232, 0), note("c", 464, 0)];
    const { box, frameHeight } = nextNotePlacement(notes[2], notes, [], frame);
    expect(box.x).toBe(0);
    expect(box.y).toBe(232);
    expect(frameHeight).toBe(232 + 200 + 24 + 60);
  });
  it("stays inside its frame instead of marching into the next one", () => {
    const frame = { id: "f", x: -24, y: -60, w: 480, h: 600 };
    const { box } = nextNotePlacement(note("a", 232, 0), [note("a", 232, 0), note("z", 0, 0)], [], frame);
    expect(box.x + box.w).toBeLessThanOrEqual(frame.x + frame.w);
  });
});

describe("duplicate placement", () => {
  it("puts the copy beside the original, past anything in the way", () => {
    expect(duplicatePlacement({ x: 0, y: 0, w: 200, h: 200 }, [])).toEqual({ dx: 232, dy: 0 });
    expect(duplicatePlacement({ x: 0, y: 0, w: 200, h: 200 }, [{ id: "n", x: 232, y: 0, w: 200, h: 200 }])).toEqual({ dx: 232, dy: 232 });
  });
});

describe("next note in a narrow frame", () => {
  it("puts a note wider than the frame on the next row instead of far below", () => {
    const frame = { id: "f", x: 0, y: 0, w: 240, h: 400 };
    const source = { id: "s", x: 16, y: 60, w: 208, h: 208 };
    const { box, frameHeight } = nextNotePlacement(source, [source], [frame], frame);
    expect(box.y).toBe(source.y + source.h + 32);
    expect(frameHeight).toBe(box.y + box.h + 24);
  });
  it("still wraps normally when a row fits", () => {
    const frame = { id: "f", x: 0, y: 0, w: 1000, h: 400 };
    const source = { id: "s", x: 24, y: 60, w: 208, h: 208 };
    const { box } = nextNotePlacement(source, [source], [frame], frame);
    expect(box.y).toBe(source.y);
    expect(box.x).toBe(source.x + source.w + 32);
  });
});

describe("dragged connector ends", () => {
  const box = (x: number, y: number, size = 208) => ({ x, y, w: size, h: size });
  const a = box(0, 0), b = box(300, 0);
  it("joins facing sides when both ends are released inside the objects", () => {
    expect(connectorEndPorts({ start: [104, 104], end: [404, 104], source: a, target: b, sourcePort: [0.5, 0], targetPort: [0.5, 0], zoom: 0.66 }))
      .toEqual({ source: [1, 0.5], target: [0, 0.5] });
  });
  it("faces vertically for stacked objects", () => {
    expect(connectorEndPorts({ start: [104, 104], end: [104, 404], source: a, target: box(0, 300), zoom: 1 }))
      .toEqual({ source: [0.5, 1], target: [0.5, 0] });
  });
  it("keeps an anchor the pointer was released on", () => {
    expect(connectorEndPorts({ start: [104, 104], end: [404, 2], source: a, target: b, targetPort: [0.5, 0], zoom: 1 }))
      .toEqual({ source: [1, 0.5], target: [0.5, 0] });
  });
  it("ignores an anchor the pointer only passed, released well inside", () => {
    expect(connectorEndPorts({ start: [104, 104], end: [404, 60], source: a, target: b, targetPort: [0.5, 0], zoom: 1 }))
      .toEqual({ source: [1, 0.5], target: [0, 0.5] });
  });
  it("never pins an edge from the middle of a tiny, zoomed-out object", () => {
    expect(connectorEndPorts({ start: [104, 104], end: [404, 104], source: a, target: b, sourcePort: [1, 0.5], targetPort: [0.5, 0], zoom: 0.1 }))
      .toEqual({ source: [1, 0.5], target: [0, 0.5] });
  });
});
