// Marker colors that stay visible as cursors on light and dark boards. Each
// person gets one at account creation so avatars and cursors tell people
// apart; anyone can change theirs in Account settings.
export const MARKER_COLORS = [
  { name: "Blue", value: "#2554c7" },
  { name: "Red", value: "#d2483c" },
  { name: "Green", value: "#2f8a57" },
  { name: "Teal", value: "#138a8a" },
  { name: "Purple", value: "#7b4fc9" },
  { name: "Orange", value: "#e07a1f" },
] as const;

// Every account used to be created with one of these fixed colors. They are
// never offered in the picker, so an account still showing one never chose it.
const LEGACY_DEFAULT_COLORS = new Set(["#3d4a73", "#4262ff"]);

export function isLegacyDefaultColor(color: string | null | undefined) {
  return LEGACY_DEFAULT_COLORS.has(String(color ?? "").toLowerCase());
}

function paletteIndex(id: string) {
  // FNV-1a: stable across runtimes, so a person keeps the same fallback color.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % MARKER_COLORS.length;
}

/** The palette color derived from an account id alone. */
export function colorForId(id: string) {
  return MARKER_COLORS[paletteIndex(id)].value;
}

/**
 * The least-used palette color, so the first people in a Studio are all
 * distinct. Ties start from the id's own color, which keeps the choice
 * deterministic for the same Studio state.
 */
export function leastUsedColor(id: string, usage: Map<string, number>) {
  const start = paletteIndex(id);
  let best: string = MARKER_COLORS[start].value;
  let fewest = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < MARKER_COLORS.length; offset++) {
    const color = MARKER_COLORS[(start + offset) % MARKER_COLORS.length].value;
    const count = usage.get(color) ?? 0;
    if (count < fewest) {
      best = color;
      fewest = count;
    }
  }
  return best;
}
