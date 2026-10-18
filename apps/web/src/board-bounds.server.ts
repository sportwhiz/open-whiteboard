import * as Y from 'yjs';
import type { NativeBoardSnapshot } from './blocksuite/runtime/snapshot';
import { parseBounds, type Rect } from './brainstorm-placement';

function field(value: unknown, key: string): unknown {
  if (value instanceof Y.Map) return value.get(key);
  if (value && typeof value === 'object') return (value as Record<string, unknown>)[key];
}

/**
 * The bounds of everything placed on a board: notes, frames, images and
 * surface elements (shapes, text, connectors, drawings). One decode and a
 * single pass over geometry; no text or semantic conversion.
 */
export function readContentBounds(snapshot: NativeBoardSnapshot): Rect[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Uint8Array.from(atob(snapshot.docs['board:home']), character => character.charCodeAt(0)), 'bounds-read');
    const result: Rect[] = [];
    for (const block of doc.getMap<Y.Map<unknown>>('blocks').values()) {
      if (!(block instanceof Y.Map)) continue;
      const flavour = block.get('sys:flavour');
      if (flavour === 'affine:surface') {
        const elements = field(block.get('prop:elements'), 'value');
        if (elements instanceof Y.Map) for (const element of elements.values()) {
          const rect = parseBounds(field(element, 'xywh'));
          if (rect) result.push(rect);
        }
        continue;
      }
      const rect = parseBounds(block.get('prop:xywh'));
      if (rect) result.push(rect);
    }
    return result;
  } finally { doc.destroy(); }
}
