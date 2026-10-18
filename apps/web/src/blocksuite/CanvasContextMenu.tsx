import { useLayoutEffect, useRef, useState } from "react";
import { usePopover } from "../usePopover";
import { canvasFitPadding } from "./canvas-layout";
import { UiIcon } from "../UiIcon";
import {
  contextMenuPosition,
  type ContextMenuAction,
  type ContextMenuSection,
} from "./context-menu";

const ARRANGE_ICONS: Record<string, Parameters<typeof UiIcon>[0]["name"]> = {
  "arrange-left": "left", "arrange-center": "center", "arrange-right": "right",
  "arrange-top": "top", "arrange-middle": "middle", "arrange-bottom": "bottom",
  "arrange-horizontal": "horizontal", "arrange-vertical": "vertical", "arrange-grid": "arrange",
};

/** A right-click menu at the pointer. Keyboard: arrows/Home/End move, Enter
 * runs, Escape closes and returns focus to the canvas. */
export function CanvasContextMenu({
  point,
  sections,
  label,
  onAction,
  onClose,
  onEscape,
}: {
  /** Pointer position relative to the canvas host. */
  point: { x: number; y: number };
  sections: ContextMenuSection[];
  label: string;
  onAction: (action: ContextMenuAction) => void;
  onClose: () => void;
  /** Return focus after Escape; return true when focus was placed. */
  onEscape: () => boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  usePopover(ref, true, onClose, undefined, `${point.x},${point.y}`, { restoreFocus: onEscape });
  useLayoutEffect(() => {
    const menu = ref.current;
    const host = menu?.offsetParent as HTMLElement | null;
    if (!menu || !host) return;
    // Clear of the floating header and bottom bars (from the board's fit
    // padding, which measures them), so the first items are never hidden.
    const canvas = host.querySelector<HTMLElement>(".editor-canvas") ?? host.parentElement?.querySelector<HTMLElement>(".editor-canvas");
    const [top, , bottom] = canvas ? canvasFitPadding(canvas) : [8, 0, 8];
    setPosition(contextMenuPosition(point, { w: menu.offsetWidth, h: menu.offsetHeight },
      { w: host.clientWidth, h: host.clientHeight }, 8, { top: Math.max(8, top - 24), bottom: Math.max(8, bottom - 24) }));
  }, [point.x, point.y, sections.length]);
  return (
    <div
      ref={ref}
      className="canvas-context-menu"
      role="menu"
      aria-label={label}
      // Rendered visible at the pointer from the start (its first item takes
      // focus at once); the layout effect moves it on screen before paint.
      style={{ left: position?.x ?? point.x, top: position?.y ?? point.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {sections.map((section) => (
        <div key={section.id} className={"context-section" + (section.layout === "icons" ? " icons" : "")} role="group" aria-label={section.label}>
          {section.label ? <span className="context-label" aria-hidden="true">{section.label}</span> : null}
          <div className="context-items">
            {section.items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={item.danger ? "danger" : undefined}
                disabled={item.disabled}
                aria-label={section.layout === "icons" ? item.label : undefined}
                data-tip={section.layout === "icons" ? item.label : undefined}
                onClick={() => onAction(item.id)}
              >
                {section.layout === "icons" ? (
                  <UiIcon name={ARRANGE_ICONS[item.id] ?? "arrange"} className="canvas-icon" />
                ) : (
                  <>
                    <span>{item.label}</span>
                    {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                  </>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
