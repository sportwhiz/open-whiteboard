import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PointerEventState } from '@blocksuite/std';

// Exercise the actual hook implementation without loading the browser-only
// editor. Undefined lets the native tool handle the event; false claims it.
vi.mock('@blocksuite/std/gfx', () => ({
  BaseTool: class {
    hooks = new Map<string, (event: PointerEventState) => boolean | void>();
    disposers: Array<() => void> = [];
    disposable = { add: (fn: () => void) => this.disposers.push(fn) };
    constructor(readonly gfx: any) {}
    get std() { return this.gfx.std; }
    get controller() { return this.gfx.tool; }
    addHook(name: string, fn: (event: PointerEventState) => boolean | void) { this.hooks.set(name, fn); }
  },
}));
import { CanvasNavigationTool } from './canvas-navigation-tool';

const disposers: Array<() => void> = [];
class TestElement { matches() { return true; } }
function fixture() {
  const delta = vi.fn();
  const cursor = vi.fn();
  const host = Object.assign(new EventTarget(), {
    closest: () => ({ classList: { toggle: cursor } }),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  });
  const gfx = {
    std: { host },
    tool: { currentTool$: { peek: () => ({ toolName: 'default' }) } },
    viewport: { centerX: 0, centerY: 0, zoom: 2, toModelCoord: (x: number, y: number) => [x / 2, y / 2], smoothTranslate: delta, setCenter: vi.fn() },
    selection: { editing: false, isInSelectedRect: () => false, selectedElements: [] as object[] },
    getElementByPoint: vi.fn((): object[] => []),
  };
  const tool = new CanvasNavigationTool(gfx as never);
  tool.mounted();
  disposers.push(() => (tool as unknown as { disposers: Array<() => void> }).disposers.forEach(dispose => dispose()));
  const hooks = (tool as unknown as { hooks: Map<string, (e: PointerEventState) => boolean | void> }).hooks;
  return { tool, gfx, delta, cursor, host, emit: (name: string, event = pointer()) => hooks.get(name)?.(event) };
}
function pointer(overrides: Record<string, unknown> = {}, x = 200, y = 300): PointerEventState {
  return { x, y, raw: { button: 0, isPrimary: true, pointerType: 'mouse', shiftKey: false, altKey: false,
    ctrlKey: false, metaKey: false, composedPath: () => [], preventDefault: vi.fn(), ...overrides } } as unknown as PointerEventState;
}
beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('HTMLElement', TestElement);
});
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose());
  vi.unstubAllGlobals();
});

describe('empty canvas navigation', () => {
  it('leaves plain left drags on empty canvas to area selection', () => {
    const { emit, delta, cursor } = fixture();
    expect(emit('pointerDown')).toBeUndefined();
    expect(emit('dragStart')).toBeUndefined();
    expect(emit('dragMove', pointer({}, 280, 340))).toBeUndefined();
    expect(emit('dragEnd')).toBeUndefined();
    expect(delta).not.toHaveBeenCalled();
    expect(cursor).not.toHaveBeenCalledWith('canvas-panning', true);
  });

  it('routes native right dragging through the same blank-canvas hit test and zoom', () => {
    const { host, delta } = fixture();
    const down = Object.assign(new Event('pointerdown', { cancelable: true }), {
      button: 2, isPrimary: true, pointerType: 'mouse', pointerId: 1, clientX: 200, clientY: 300,
    });
    host.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    window.dispatchEvent(Object.assign(new Event('pointermove', { cancelable: true }), {
      buttons: 2, pointerId: 1, clientX: 280, clientY: 340,
    }));
    expect(delta).toHaveBeenLastCalledWith(-40, -20, 1);
  });

  it('pans from objects, frames, selections and with any tool', () => {
    for (const setup of ['object', 'frame', 'selection', 'shape-tool'] as const) {
      const { host, gfx, delta } = fixture();
      if (setup === 'object') gfx.getElementByPoint.mockReturnValue([{ id: 'note', flavour: 'affine:note' }]);
      if (setup === 'frame') gfx.getElementByPoint.mockReturnValue([{ flavour: 'affine:frame' }]);
      if (setup === 'selection') { gfx.selection.isInSelectedRect = () => true; gfx.selection.selectedElements = [{ flavour: 'affine:note' }]; }
      if (setup === 'shape-tool') gfx.tool.currentTool$.peek = () => ({ toolName: 'shape' });
      const down = Object.assign(new Event('pointerdown', { cancelable: true }), {
        button: 2, isPrimary: true, pointerType: 'mouse', pointerId: 1, clientX: 200, clientY: 300, composedPath: () => [],
      });
      host.dispatchEvent(down);
      window.dispatchEvent(Object.assign(new Event('pointermove', { cancelable: true }), {
        buttons: 2, pointerId: 1, clientX: 280, clientY: 340,
      }));
      expect(down.defaultPrevented).toBe(true);
      expect(delta).toHaveBeenCalledTimes(1);
      disposers.pop()!();
    }
  });

  it('keeps right-clicks in text being written and on controls', () => {
    for (const kind of ['editing', 'control']) {
      const { host, gfx, delta } = fixture();
      if (kind === 'editing') gfx.selection.editing = true;
      const event = Object.assign(new Event('pointerdown', { cancelable: true }), {
        button: 2, isPrimary: true, pointerType: 'mouse', pointerId: 1, clientX: 200, clientY: 300,
        composedPath: () => kind === 'control' ? [new TestElement()] : [],
      });
      host.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(delta).not.toHaveBeenCalled();
      disposers.pop()!();
    }
  });
});
