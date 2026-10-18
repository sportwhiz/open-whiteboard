/** Rapid arrow-key nudges share one undo step until the user pauses. */
export const NUDGE_MERGE_MS = 500;

export function startsNewStep(previous: { at: number; key: string } | null, now: number, key: string, window = NUDGE_MERGE_MS) {
  return !previous || previous.key !== key || now - previous.at > window;
}

/** Arrow key to movement in board units; Shift moves 10. */
export function nudgeDelta(key: string, shift: boolean): [number, number] | null {
  const step = shift ? 10 : 1;
  switch (key) {
    case "ArrowLeft": return [-step, 0];
    case "ArrowRight": return [step, 0];
    case "ArrowUp": return [0, -step];
    case "ArrowDown": return [0, step];
    default: return null;
  }
}
