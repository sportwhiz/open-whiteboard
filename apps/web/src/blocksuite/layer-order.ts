import { generateNKeysBetween } from "fractional-indexing";

type Indexed = { id: string; index: string };

/**
 * New fractional indexes that move a selection to the front or back of its
 * siblings as one block. Keys are generated together, so the selection keeps
 * its own stacking order and every collaborator computes the same result;
 * reordering each object separately gave them all the same key.
 */
export function layerOrder(siblings: Indexed[], selected: Indexed[], direction: "front" | "back"): Map<string, string> {
  const result = new Map<string, string>();
  if (!selected.length) return result;
  const byIndex = (a: Indexed, b: Indexed) => (a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const chosen = new Set(selected.map((item) => item.id));
  const others = siblings.filter((item) => !chosen.has(item.id)).sort(byIndex);
  const ordered = [...selected].sort(byIndex);
  // Already in place: leave the document untouched.
  const all = [...siblings].sort(byIndex);
  const edge = direction === "front" ? all.slice(-ordered.length) : all.slice(0, ordered.length);
  if (edge.every((item, i) => item.id === ordered[i].id)) return result;
  const keys = direction === "front"
    ? generateNKeysBetween(others.at(-1)?.index ?? null, null, ordered.length)
    : generateNKeysBetween(null, others[0]?.index ?? null, ordered.length);
  ordered.forEach((item, i) => result.set(item.id, keys[i]));
  return result;
}
