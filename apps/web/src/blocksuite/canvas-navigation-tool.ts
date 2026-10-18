import { BaseTool } from '@blocksuite/std/gfx';
import { attachRightButtonNavigation, createViewportPan } from './right-button-navigation';

/** Right-drag anywhere on the board moves the viewport. Left-drag stays with
 * the engine, so it selects an area as it does in other whiteboards;
 * trackpad scrolling, Space + drag and the Hand tool still pan. */
export class CanvasNavigationTool extends BaseTool {
  static override toolName = 'whiteboard:canvas-navigation';

  private setPanning(value: boolean) {
    this.std.host.closest('.editor-canvas')?.classList.toggle('canvas-panning', value);
  }

  override mounted() {
    const pan = createViewportPan(this.gfx.viewport);
    this.disposable.add(attachRightButtonNavigation(this.std.host, {
      canStart: raw => {
        const bounds = this.std.host.getBoundingClientRect();
        return this.canNavigate(raw, raw.clientX - bounds.left, raw.clientY - bounds.top);
      },
      pan: pan.move,
      setPanning: value => { if (!value) pan.end(); this.setPanning(value); },
    }));
  }

  /** Right-drag pans from anywhere - over objects, selections and frames,
   * with any tool - so dense boards stay easy to move around. A right-click
   * without movement still opens the context menu. Text being written and
   * controls keep their own right-click. */
  private canNavigate(raw: PointerEvent, _viewX: number, _viewY: number) {
    const interactive = raw.composedPath().some(target => target instanceof HTMLElement &&
      target.matches('button, input, textarea, select, [contenteditable="true"], [role="button"], affine-toolbar-widget'));
    return !this.gfx.selection.editing && !interactive;
  }
}
