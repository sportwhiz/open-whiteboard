import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasController, CanvasState } from "./canvas-controller";

/** Measure the actual rich text, including mixed marks and loaded fonts. The
 * same size is used by the native canvas and the editing overlay, in note
 * coordinates (independent of viewport zoom and the note's resize scale). */
export function useStickyTextLayout(host: HTMLElement, state: CanvasState, controller: CanvasController) {
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [fontsRevision, setFontsRevision] = useState(0);
  const fontRevisions = useRef(new Map<string, number>());
  const normalizeFamily = (family: string) => family.trim().replace(/^[\'"]|[\'"]$/g, "").toLowerCase();
  const [renderRevision, setRenderRevision] = useState(0);
  const measurements = useRef(new Map<string, { text: HTMLElement; key: string; size: number }>());
  useEffect(() => {
    const loaded = (event: Event) => {
      for (const face of (event as FontFaceSetLoadEvent).fontfaces) {
        const family = normalizeFamily(face.family);
        fontRevisions.current.set(family, (fontRevisions.current.get(family) ?? 0) + 1);
      }
      setFontsRevision((revision) => revision + 1);
    };
    let active = true;
    void document.fonts.ready.then(() => { if (active) { measurements.current.clear(); setFontsRevision(revision => revision + 1); } });
    document.fonts.addEventListener("loadingdone", loaded);
    return () => { active = false; document.fonts.removeEventListener("loadingdone", loaded); };
  }, []);
  useLayoutEffect(() => {
    // Native blocks can mount their inline editor after React's layout pass,
    // including when a previously hidden note enters the viewport. Measure
    // that rendered text even when the document itself has not changed.
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        setRenderRevision(value => value + 1);
      });
    };
    const observer = new MutationObserver(records => {
      if (records.some(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        return target?.closest("affine-edgeless-note") || Array.from(record.addedNodes).some(node =>
          node instanceof Element && (node.matches("affine-edgeless-note") || node.querySelector("affine-edgeless-note")));
      })) schedule();
    });
    observer.observe(host, { childList: true, characterData: true, subtree: true });
    schedule();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [host]);
  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    // Query the board once, then remeasure only changed notes. Repeated CSS
    // writes plus scrollHeight reads on every note caused full-board layouts
    // while typing a single idea.
    const blocks = new Map(Array.from(host.querySelectorAll<HTMLElement>("affine-edgeless-note[data-block-id]"),
      block => [block.dataset.blockId!, block]));
    const live = new Set<string>();
    for (const note of state.items) {
      const block = blocks.get(note.id);
      if (!block) continue;
      block.toggleAttribute("data-whiteboard-sticky", note.simpleSticky);
      if (!note.simpleSticky || note.textStyle.size !== "auto") {
        measurements.current.delete(note.id);
        block.style.removeProperty("--sticky-auto-size");
        continue;
      }
      const text = block.querySelector<HTMLElement>(".inline-editor");
      if (!text) continue;
      live.add(note.id);
      // The rendered markup includes partial bold/italic changes, which the
      // whole-note toolbar's aggregated marks cannot distinguish.
      const fontKey = getComputedStyle(text).fontFamily.split(",").map(family => [family, fontRevisions.current.get(normalizeFamily(family)) ?? 0]);
      const key = JSON.stringify([text.innerHTML, note.w, note.h, note.textScale,
        note.textStyle, fontKey, state.editing?.id === note.id ? document.fonts.status : null, state.editing?.id === note.id, note.locked, controller.editable()]);
      const cached = measurements.current.get(note.id);
      if (cached?.text === text && cached.key === key) {
        next[note.id] = cached.size;
        continue;
      }
      const available = Math.max(1, note.h / note.textScale - 48);
      let low = 12;
      let high = 28;
      // Integral sizes avoid continuous layout jitter during typing.
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        block.style.setProperty("--sticky-auto-size", `${mid}px`);
        if (text.scrollHeight <= available && text.scrollWidth <= text.clientWidth + 1) low = mid;
        else high = mid - 1;
      }
      block.style.setProperty("--sticky-auto-size", `${low}px`);
      next[note.id] = low;
      measurements.current.set(note.id, { text, key, size: low });
      // Once text reaches a readable minimum, grow the paper instead of
      // hiding the end of a longer note. Only the author grows shared paper,
      // after fonts settle; observers must never acquire undo entries. Growth
      // stays in the author's current typing transaction.
      if (state.editing?.id === note.id && document.fonts.status === "loaded" &&
          fontsRevision > 0 && low === 12 && text.scrollHeight > available)
        controller.fitAutoNoteHeight(note.id, text.scrollHeight);
    }
    for (const id of measurements.current.keys()) if (!live.has(id)) measurements.current.delete(id);
    setSizes((previous) =>
      Object.keys(previous).length === Object.keys(next).length &&
      Object.entries(next).every(([id, size]) => previous[id] === size) ? previous : next,
    );
  }, [host, state.items, state.editing?.id, controller, fontsRevision, renderRevision]);
  return sizes;
}
