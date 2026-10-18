import { describe, expect, it } from "vitest";
import { layerOrder } from "./layer-order";

const items = (...pairs: [string, string][]) => pairs.map(([id, index]) => ({ id, index }));
const stack = (siblings: { id: string; index: string }[], changes: Map<string, string>) =>
  siblings.map((item) => ({ ...item, index: changes.get(item.id) ?? item.index }))
    .sort((a, b) => (a.index < b.index ? -1 : 1)).map((item) => item.id);

describe("bring to front / send to back", () => {
  const siblings = items(["a", "a0"], ["b", "a1"], ["c", "a2"], ["d", "a3"]);
  it("moves a multi-selection above everything, keeping its own order", () => {
    const changes = layerOrder(siblings, items(["b", "a1"], ["a", "a0"]), "front");
    expect(stack(siblings, changes)).toEqual(["c", "d", "a", "b"]);
    expect(new Set(changes.values()).size).toBe(2);
  });
  it("moves a multi-selection below everything, keeping its own order", () => {
    expect(stack(siblings, layerOrder(siblings, items(["d", "a3"], ["c", "a2"]), "back"))).toEqual(["c", "d", "a", "b"]);
  });
  it("is deterministic and leaves objects already in place alone", () => {
    const selection = items(["a", "a0"], ["c", "a2"]);
    expect([...layerOrder(siblings, selection, "front")]).toEqual([...layerOrder(siblings, [...selection].reverse(), "front")]);
    expect(layerOrder(siblings, items(["c", "a2"], ["d", "a3"]), "front").size).toBe(0);
    expect(layerOrder(siblings, items(["a", "a0"]), "back").size).toBe(0);
  });
});
