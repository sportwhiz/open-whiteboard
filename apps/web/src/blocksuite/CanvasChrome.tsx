import { createPortal, flushSync } from "react-dom";
import { focusOrFallback, usePopover } from "../usePopover";
import { DEMO_PATTERNS } from "./demo-patterns";
import { PatternPreview } from "./PatternPreview";
import { openTour } from "../onboarding-events";
import { UiIcon } from "../UiIcon";
import { canvasPointAt } from "./canvas-hit-test";
import { useStickyTextLayout } from "./sticky-text-layout";
import { QuickActions, type QuickAction } from "./QuickActions";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ConnectorMode,
  ShapeType,
  type ShapeName,
} from "@blocksuite/affine/model";
import {
  STICKY_COLORS,
  SHAPE_SIZE,
  TEXT_MARKS,
  type TextMark,
  type CanvasController,
  type CanvasOptions,
  type CanvasState,
  type CanvasTool,
} from "./canvas-controller";
import { CONNECTION_PORTS, type Direction, type Arrangement } from "./layout";
import { usePointerDrag, type DragPoint } from "./pointer-drag";
import { loadToolPreferences, saveToolPreferences } from "./tool-preferences";
import {
  STICKY_ALIGNMENTS,
  STICKY_FONTS,
  STICKY_SIZES,
  STICKY_TEXT_COLORS,
  stickyFontCss,
  stickySizePx,
  stickyTextCss,
  type StickyAlign,
  type StickyTextStyle,
} from "./sticky-text-style";
import {
  createStickyInlineEditor,
  IS_MAC,
  MARK_SHORTCUTS,
  markForShortcut,
  pastedStickyText,
  type StickyInlineEditor,
} from "./sticky-rich-text";
import { isZoomAt, zoomCommandForKey, zoomLabel, ZOOM_PRESETS, type ZoomCommand } from "./canvas-zoom";
import { ARRANGE_LABELS, ARRANGE_ORDER, arrangeMinimum, contextMenuSections, type ContextMenuAction } from "./context-menu";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { ElementToolbar } from "./ElementToolbar";
import { usePopoverInView } from "./popover-in-view";
import { elementToolbarKind } from "./element-toolbar";
import { nudgeDelta } from "./history-merge";
import { canvasFitPadding } from "./canvas-layout";
import { balancedRowWidth, placeToolbar, type Rect } from "./toolbar-placement";
import { sameStickyFamily, stickyPaper } from "./sticky-palette";
import "./canvas-chrome.css";

const ALIGN_ICONS: Record<StickyAlign, IconName> = {
  left: "alignLeft",
  center: "alignCenter",
  right: "alignRight",
};
const shortcutLabel = (mark: TextMark) =>
  (IS_MAC ? "⌘" : "Ctrl+") +
  (MARK_SHORTCUTS[mark].shift ? (IS_MAC ? "⇧" : "Shift+") : "") +
  MARK_SHORTCUTS[mark].key.toUpperCase();
const ARRANGEMENTS = ARRANGE_LABELS;
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";

/** Sticky paper follows the app theme, like the native canvas renders it. */
function useDarkTheme() {
  const read = () => document.documentElement.dataset.theme === "dark";
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}
const paperFor = (color: string, dark: boolean) => (dark ? stickyPaper(color).dark : color);
/** Frame title labels live in each frame's title widget (in shadow DOM). */
function frameTitles(host: HTMLElement) {
  return Array.from(host.querySelectorAll("affine-frame")).flatMap((frame) =>
    [frame, frame.shadowRoot].flatMap((root) => Array.from(root?.querySelectorAll("affine-frame-title-widget") ?? []))
      .flatMap((widget) => Array.from((widget.shadowRoot ?? widget).querySelectorAll("affine-frame-title"))));
}
function unionView(boxes: Array<Rect | null>): Rect | null {
  return boxes.reduce<Rect | null>((union, next) => {
    if (!next) return union;
    if (!union) return next;
    const x = Math.min(union.x, next.x), y = Math.min(union.y, next.y);
    return { x, y, w: Math.max(union.x + union.w, next.x + next.w) - x, h: Math.max(union.y + union.h, next.y + next.h) - y };
  }, null);
}

// Native navigation and selection shortcuts are scoped to editor-host. The
// outer shell handles product shortcuts but cannot activate Space-to-pan.
function focusCanvas(host: HTMLElement) {
  (host.querySelector<HTMLElement>("editor-host") ?? host).focus({ preventScroll: true });
}

type IconName =
  | CanvasTool
  | "templates"
  | "upload"
  | "undo"
  | "redo"
  | "search"
  | "fit"
  | "minus"
  | "plus"
  | "close"
  | "help"
  | "map"
  | "arrange"
  | "arrow"
  | "grid"
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "textColor"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "lock"
  | "duplicate"
  | "commands";
function Icon({ name }: { name: IconName }) {
  return <UiIcon name={name} className="canvas-icon" />;
}
type ShortcutRow = [label: string, keys: string, icon?: IconName];
const SHORTCUT_SECTIONS: { title: string; items: ShortcutRow[] }[] = [
  { title: "Tools", items: [["Eraser (in Pen options)", "E", "eraser"], ["Rectangle / ellipse", "R / O", "shape"], ["Laser pointer", "Hold Shift + L", "select"]] },
  { title: "Create and edit", items: [
    ["Place a note, shape or text in view", "N, S or T, then Enter"],
    ["Write in the selected note, shape or text", "Enter or double-click"],
    ["Next sticky note", `Tab or ${MOD}Enter while writing`],
    ["Finish writing / deselect", "Esc"],
    ["Bold / italic / underline", `${MOD}B / ${MOD}I / ${MOD}U`],
    ["Strikethrough", `${MOD}${SHIFT}X`],
    ["Copy / paste", `${MOD}C / ${MOD}V`],
    ["Duplicate", `${MOD}D`],
    ["Delete", IS_MAC ? "⌫" : "Delete"],
    ["Undo / redo", `${MOD}Z / ${MOD}${SHIFT}Z`],
  ] },
  { title: "Arrange", items: [
    ["Select all", `${MOD}A`],
    ["Add to selection", "Shift + click"],
    ["Nudge", "Arrow keys (Shift for 10×)"],
    ["Bring to front / send to back", "] / ["],
    ["Group / ungroup", `${MOD}G / ${MOD}${SHIFT}G`],
    ["Align, distribute, tidy", "Arrange in the toolbar"],
    ["Object actions", IS_MAC ? "Right-click or ⇧F10" : "Right-click or Shift+F10"],
  ] },
  { title: "View and navigation", items: [
    ["Zoom in / out", `${MOD}+ / ${MOD}−`],
    ["Zoom to 100%", `${SHIFT}0, ${MOD}0 or ${IS_MAC ? "⌥" : "Alt+"}0`],
    ["Fit board", `${SHIFT}1 or ${IS_MAC ? "⌥" : "Alt+"}1`],
    ["Zoom to selection", `${SHIFT}2 or ${IS_MAC ? "⌥" : "Alt+"}2`],
    ["Pan", "Scroll, Space + drag, or right-drag"],
    ["Next / previous object", "Tab / Shift + Tab"],
    ["Move between board areas", "F6 / Shift + F6"],
    ["Find on board", `${MOD}F`],
    ["Comment", "C"],
    ["Quick actions", `${MOD}K`],
    ["Keyboard shortcuts", "?"],
  ] },
];
const TOOL_KEYS: Record<string, CanvasTool> = {
  v: "select", h: "hand", n: "sticky", t: "text", s: "shape", r: "shape",
  o: "shape", l: "connector", p: "pen", e: "eraser", f: "frame",
};
const TOOLS: { id: CanvasTool; label: string; key: string }[] = [
  { id: "select", label: "Select", key: "V" },
  { id: "hand", label: "Hand", key: "H" },
  { id: "sticky", label: "Sticky note", key: "N" },
  { id: "text", label: "Text", key: "T" },
  { id: "shape", label: "Shapes", key: "S" },
  { id: "connector", label: "Connection line", key: "L" },
  { id: "pen", label: "Pen", key: "P" },
  { id: "frame", label: "Frame", key: "F" },
];
const SHAPES: { id: ShapeName; label: string; content: ReactNode }[] = [
  {
    id: "roundedRect",
    label: "Rounded rectangle",
    content: <rect x="4" y="6" width="24" height="20" rx="5" />,
  },
  {
    id: ShapeType.Rect,
    label: "Rectangle",
    content: <rect x="4" y="6" width="24" height="20" />,
  },
  {
    id: ShapeType.Ellipse,
    label: "Ellipse",
    content: <ellipse cx="16" cy="16" rx="12" ry="10" />,
  },
  {
    id: ShapeType.Diamond,
    label: "Decision",
    content: <path d="m16 3 13 13-13 13L3 16Z" />,
  },
  {
    id: ShapeType.Triangle,
    label: "Triangle",
    content: <path d="m16 4 13 24H3Z" />,
  },
];
function Palette({
  color,
  onChange,
  disabled = false,
  onDragStart,
  consumeClick,
  dark = false,
}: {
  dark?: boolean;
  onDragStart?: (
    event: ReactPointerEvent<HTMLButtonElement>,
    color: string,
  ) => void;
  consumeClick?: () => boolean;
  color: string;
  onChange: (color: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="sticky-swatches" aria-label="Sticky note colors">
      {STICKY_COLORS.map((c) => (
        <button
          type="button"
          key={c.value}
          disabled={disabled}
          aria-label={c.name + " sticky note"}
          aria-pressed={sameStickyFamily(color, c.value)}
          title={c.name}
          style={{ background: paperFor(c.value, dark) }}
          onPointerDown={(event) => onDragStart?.(event, c.value)}
          onClick={() => {
            if (!consumeClick?.()) onChange(c.value);
          }}
        />
      ))}
    </div>
  );
}
function ConnectionPreview({
  preview,
  controller,
}: {
  preview: NonNullable<ReturnType<CanvasController["connectionPreview"]>>;
  controller: CanvasController;
}) {
  const source = controller.toViewBox(preview.source);
  const target = controller.toViewBox(preview.target);
  const ports = CONNECTION_PORTS[preview.direction];
  const sx = source.x + source.w * ports.source[0],
    sy = source.y + source.h * ports.source[1];
  const tx = target.x + target.w * ports.target[0],
    ty = target.y + target.h * ports.target[1];
  const horizontal =
    preview.direction === "left" || preview.direction === "right";
  const d = horizontal
    ? `M${sx} ${sy} H${(sx + tx) / 2} V${ty} H${tx}`
    : `M${sx} ${sy} V${(sy + ty) / 2} H${tx} V${ty}`;
  return (
    <div className="connection-preview" aria-hidden="true">
      <svg>
        <path d={d} />
      </svg>
      <div
        className={
          preview.existing ? "connection-target existing" : "connection-target"
        }
        style={{
          left: target.x,
          top: target.y,
          width: target.w,
          height: target.h,
          background: preview.existing ? undefined : preview.target.color,
        }}
      />
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    (
      dialog?.querySelector<HTMLElement>("textarea, input") ??
      dialog?.querySelector<HTMLElement>("button")
    )?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== "Tab" || !dialog) return;
      const controls = [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input, textarea, a[href], select",
        ),
      ];
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog?.addEventListener("keydown", key);
    return () => {
      dialog?.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="canvas-modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={"canvas-modal" + (wide ? " wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="canvas-icon-button"
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function CanvasChrome({
  controller,
  host,
  onComment,
  canComment,
}: {
  controller: CanvasController;
  host: HTMLElement;
  onComment: () => void;
  canComment: boolean;
}) {
  const [state, setState] = useState<CanvasState>(() => controller.state());
  const commentRef = useRef({ can: canComment, open: onComment });
  commentRef.current = { can: canComment, open: onComment };
  const dark = useDarkTheme();
  const fittedSizes = useStickyTextLayout(host, state, controller);
  const [options, setOptions] = useState<CanvasOptions>(loadToolPreferences);
  const [palette, setPalette] = useState<CanvasTool | null>(null);
  const [modal, setModal] = useState<"bulk" | "templates" | "help" | "actions" | null>(
    null,
  );
  const [bulk, setBulk] = useState("");
  const [navigation, setNavigation] = useState<
    "search" | "frames" | "map" | null
  >(null);
  const [query, setQuery] = useState("");
  const [activeSearchId, setActiveSearchId] = useState("");
  const [zoomMenu, setZoomMenu] = useState(false);
  // The rich editor of the note being edited, and its last text selection,
  // which survives focus moving to a toolbar menu.
  const inlineRef = useRef<StickyInlineEditor | null>(null);
  const lastRange = useRef<{ index: number; length: number } | null>(null);
  const rangeSubscription = useRef<{ unsubscribe(): void } | null>(null);
  const [, setInlineVersion] = useState(0);
  // Selection toolbar menus are exclusive: one is open at a time.
  const [textMenu, setTextMenu] = useState<"paper" | "textColor" | "align" | "arrange" | null>(null);
  const stickyBarRef = useRef<HTMLDivElement>(null);
  const [stickyBarSize, setStickyBarSize] = useState({ w: 560, h: 54 });
  const textPanelRef = useRef<HTMLDivElement>(null);
  const menuTriggers = {
    paper: useRef<HTMLButtonElement>(null),
    textColor: useRef<HTMLButtonElement>(null),
    align: useRef<HTMLButtonElement>(null),
    arrange: useRef<HTMLButtonElement>(null),
  };
  const palettePanelRef = useRef<HTMLElement>(null);
  const paletteTriggerRef = useRef<HTMLButtonElement>(null);
  // Escape in a tool's options returns to Select, as it does on the canvas;
  // otherwise the next click on a note would stack a new one on top of it.
  usePopover(palettePanelRef, palette !== null, () => setPalette(null), paletteTriggerRef, palette, {
    restoreFocus: () => {
      controller.selectTool("select", optionsRef.current);
      focusCanvas(host);
      return true;
    },
  });
  const zoomPanelRef = useRef<HTMLDivElement>(null);
  const zoomTriggerRef = useRef<HTMLButtonElement>(null);
  // While writing in a note, closing a formatting menu puts the caret back
  // where it was, so typing continues in the note.
  usePopover(textPanelRef, textMenu !== null, () => setTextMenu(null), textMenu ? menuTriggers[textMenu] : undefined, textMenu, {
    restoreFocus: () => returnToEditor(),
  });
  usePopover(zoomPanelRef, zoomMenu, () => setZoomMenu(false), zoomTriggerRef);
  usePopoverInView(textPanelRef, textMenu, host);
  // The menu is built from the selection the right-click produced, read from
  // the engine at once rather than from React state a frame later.
  // More › All options shows the engine's toolbar (docked at the bottom)
  // instead of ours, for the rarely used controls we do not offer.
  const [engineToolbar, setEngineToolbar] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; key: number; selection: CanvasState["selection"]; clipboardEmpty?: boolean } | null>(null);
  const [grid, setGrid] = useState(() => {
    try { return localStorage.getItem('whiteboard-grid') !== 'hidden'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('whiteboard-grid', grid ? 'visible' : 'hidden'); } catch { /* Storage may be unavailable. */ }
  }, [grid]);
  // Board messages: errors in the danger style, information neutral.
  const [noticeState, setNoticeState] = useState<{ text: string; tone: "error" | "info" }>({ text: "", tone: "error" });
  const notice = noticeState.text;
  const setNotice = (text: string, tone: "error" | "info" = "error") => setNoticeState({ text, tone });
  useEffect(() => {
    if (noticeState.tone !== "info" || !noticeState.text) return;
    const timer = window.setTimeout(() => setNoticeState((current) => (current.tone === "info" ? { ...current, text: "" } : current)), 4000);
    return () => window.clearTimeout(timer);
  }, [noticeState]);
  // Paste is offered when something was copied on the board this session,
  // or when the browser lets us confirm the clipboard has content.
  const copiedThisSession = useRef(false);
  useEffect(() => {
    const copied = (event: Event) => {
      if (event.target instanceof Node && (host.contains(event.target) || event.target === document.body)) copiedThisSession.current = true;
    };
    document.addEventListener("copy", copied, true);
    document.addEventListener("cut", copied, true);
    return () => { document.removeEventListener("copy", copied, true); document.removeEventListener("cut", copied, true); };
  }, [host]);
  const chromeRef = useRef<HTMLDivElement>(null);
  // On phones the rail scrolls sideways; mark which edge hides more tools.
  const railRef = useRef<HTMLElement>(null);
  const updateRailOverflow = () => {
    const rail = railRef.current;
    if (!rail) return;
    const scrollable = rail.scrollWidth > rail.clientWidth + 2;
    rail.classList.toggle("more-left", scrollable && rail.scrollLeft > 2);
    rail.classList.toggle("more-right", scrollable && rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 2);
    chromeRef.current?.classList.toggle("rail-has-more", scrollable && rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 2);
  };
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    updateRailOverflow();
    const observer = new ResizeObserver(updateRailOverflow);
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);
  // On phones the header wraps onto two rows; dock board navigation beside
  // its second row instead of stacking a third floating bar below it.
  const utilitiesRef = useRef<HTMLDivElement>(null);
  const [utilitiesDock, setUtilitiesDock] = useState<{ top: number } | null>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const place = () => {
      setNarrow(host.clientWidth < 1040);
      const bar = utilitiesRef.current;
      const actions = host.closest(".app-shell")?.querySelector(".app-header .header-actions")?.getBoundingClientRect();
      const heading = host.closest(".app-shell")?.querySelector(".app-header .board-heading")?.getBoundingClientRect();
      const origin = host.getBoundingClientRect();
      if (!bar || !actions || !heading || host.clientWidth > 600) return setUtilitiesDock(null);
      const fits = actions.top >= heading.bottom - 1 && actions.left - origin.left - 8 >= bar.offsetWidth + 8;
      // Otherwise sit just under the header, however many rows it wraps to.
      setUtilitiesDock(fits ? { top: actions.top - origin.top + (actions.height - bar.offsetHeight) / 2 }
        : { top: Math.max(heading.bottom, actions.bottom) - origin.top + 8 });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(host);
    return () => observer.disconnect();
  }, [host]);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [placement, setPlacement] = useState<{
    tool: "sticky" | "shape";
    x: number;
    y: number;
    options: CanvasOptions;
  } | null>(null);
  const [connectionPreview, setConnectionPreview] =
    useState<ReturnType<CanvasController["connectionPreview"]>>(null);
  const dragIntent = useRef<
    | { tool: "sticky" | "shape"; options: CanvasOptions }
    | { source: string; direction: Direction }
    | null
  >(null);
  const canvasPoint = (point: DragPoint) => canvasPointAt(host, point);
  const drag = usePointerDrag({
    preview(point) {
      const local = point && canvasPoint(point);
      const intent = dragIntent.current;
      if (!local || !intent || !controller.editable()) {
        setPlacement(null);
        setConnectionPreview(null);
        return;
      }
      setPalette(null);
      if ("tool" in intent) setPlacement({ ...intent, ...local });
      else
        setConnectionPreview(
          controller.connectionPreview(intent.source, intent.direction, local),
        );
    },
    drop(point) {
      const local = canvasPoint(point);
      const intent = dragIntent.current;
      dragIntent.current = null;
      if (!local || !intent || !controller.editable()) return;
      if ("tool" in intent)
        controller.placeTool(intent.tool, local.x, local.y, intent.options);
      else controller.connectNext(intent.direction, intent.source, local);
      focusCanvas(host);
    },
  });
  useEffect(() => {
    saveToolPreferences(options);
  }, [options]);
  useEffect(() => {
    const preview = (event: Event) => {
      const point = (
        event as CustomEvent<{ x: number; y: number; color: string } | null>
      ).detail;
      setPlacement(
        point
          ? {
              tool: "sticky",
              x: point.x,
              y: point.y,
              options: { ...optionsRef.current, color: point.color },
            }
          : null,
      );
    };
    host.addEventListener("whiteboard-sticky-preview", preview);
    return () => host.removeEventListener("whiteboard-sticky-preview", preview);
  }, [host]);
  useEffect(() => {
    setConnectionPreview(null);
  }, [state.selection[0]?.id]);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(
    () => controller.subscribe(() => setState(controller.state())),
    [controller],
  );
  useEffect(() => {
    // Wrap native controls without clipping their popovers. The product owns
    // sticky connector handles, so hide the engine's duplicate handles there.
    const toolbarStyle = document.createElement("style");
    // The engine's toolbar (groups, frames, shapes, connectors, images, mixed
    // selections) wears the product toolbar's surface, radius, spacing and
    // shadow so both read as one system.
    toolbarStyle.textContent = "editor-toolbar { max-width: calc(100vw - 32px); height: auto; min-height: 44px; padding: 4px 8px; gap: 4px; align-items: center; flex-wrap: wrap; overflow: visible; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 4px 18px #23304a12; font: 12px/1.3 inherit; } editor-toolbar > * { flex-shrink: 0; } editor-toolbar editor-toolbar-separator { margin: 0 4px; opacity: .7; } editor-menu-action[data-testid=\"create-linked-doc\"] { display: none; } editor-toolbar[data-placement] { position: fixed !important; inset: auto auto 84px 50% !important; transform: translateX(-50%) !important; width: max-content !important; max-width: calc(100vw - 24px) !important; } @media (max-width: 600px) { editor-toolbar[data-placement] { bottom: 140px !important; } }";
    const attach = () => {
      const toolbar = host.querySelector("affine-toolbar-widget")?.shadowRoot;
      if (toolbar && !toolbarStyle.isConnected) toolbar.append(toolbarStyle);
    };
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(attach); };
    const observer = new MutationObserver(schedule);
    observer.observe(host, { childList: true, subtree: true });
    const closeOtherMenus = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail !== true) return;
      const path = new Set(event.composedPath());
      const toolbar = host.querySelector("affine-toolbar-widget")?.shadowRoot;
      if (!toolbar) return;
      const visit = (root: ShadowRoot) => {
        for (const element of root.querySelectorAll<HTMLElement>("*")) {
          if (element.localName === "editor-menu-button" && element.dataset.open && !path.has(element)) {
            (element as HTMLElement & { hide(): void }).hide();
          }
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      };
      visit(toolbar);
    };
    host.addEventListener("toggle", closeOtherMenus, true);
    schedule();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); host.removeEventListener("toggle", closeOtherMenus, true); toolbarStyle.remove(); };
  }, [host]);
  useEffect(() => {
    const doubleClick = (event: MouseEvent) => {
      // Double-clicking a word in the note being written selects the word.
      if ((event.target as Element | null)?.closest?.(".sticky-text-editor")) return;
      const point = canvasPointAt(host, {
        x: event.clientX,
        y: event.clientY,
      });
      if (!point) return;
      if (
        controller.editNoteAtPoint(point.x, point.y)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    host.addEventListener("dblclick", doubleClick, true);
    return () => host.removeEventListener("dblclick", doubleClick, true);
  }, [controller, host]);
  useEffect(() => {
    host.classList.toggle("canvas-grid", grid);
    return () => host.classList.remove("canvas-grid");
  }, [host, grid]);
  useEffect(() => {
    const { spacing, x, y } = controller.gridStyle();
    host.style.setProperty("--grid-spacing", spacing + "px");
    host.style.setProperty("--grid-position-x", x + "px");
    host.style.setProperty("--grid-position-y", y + "px");
  }, [host, state, controller]);
  const useTool = (tool: CanvasTool, updated = optionsRef.current) => {
    controller.selectTool(tool, updated);
    setPalette(null);
    setNavigation(null);
    setTextMenu(null);
    setZoomMenu(false);
    focusCanvas(host);
  };
  const changeOptions = (patch: Partial<CanvasOptions>) => {
    const next = { ...optionsRef.current, ...patch };
    setOptions(next);
    if (palette) controller.selectTool(palette, next);
  };
  // Menus focus their first item so arrow keys work at once; show that focus
  // ring only to people using the keyboard, not after a click.
  useEffect(() => {
    const mark = (input: "keyboard" | "pointer") => {
      if (chromeRef.current && chromeRef.current.dataset.input !== input) chromeRef.current.dataset.input = input;
    };
    const key = (event: KeyboardEvent) => { if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) mark("keyboard"); };
    const pointer = () => mark("pointer");
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", pointer, true);
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", pointer, true); };
  }, []);
  // A visible ring around the board when keyboard focus lands on it.
  const markKeyboardFocus = (on: boolean) => host.classList.toggle("canvas-keyboard-focus", on);
  useEffect(() => {
    const off = () => markKeyboardFocus(false);
    const leave = (event: FocusEvent) => { if (!host.contains(event.relatedTarget as Node | null)) off(); };
    host.addEventListener("pointerdown", off, true);
    host.addEventListener("focusout", leave);
    return () => { host.removeEventListener("pointerdown", off, true); host.removeEventListener("focusout", leave); off(); };
  }, [host]);
  const runZoomRef = useRef<(command: ZoomCommand) => void>(() => undefined);
  runZoomRef.current = (command) => {
    if (command === "in" || command === "out") controller.zoomStep(command === "in" ? 1 : -1);
    else if (command === "reset") controller.zoom(1);
    else if (command === "fit") controller.fit();
    else if (!controller.fitSelection()) flashHint("Select something to zoom to it");
  };
  /** F6 order: board, selection toolbar, comment pins, tools, board navigation, zoom, page header. */
  const cycleRegionRef = useRef<(direction: 1 | -1) => void>(() => undefined);
  cycleRegionRef.current = (direction) => {
    const shell = host.closest(".app-shell") ?? document;
    const regions: Array<{ root: Element | null; focus: () => boolean }> = [
      { root: host, focus: () => { focusCanvas(host); markKeyboardFocus(true); return true; } },
      ...[".sticky-selection-actions", ".canvas-comment-pins", ".creation-rail", ".canvas-utilities", ".canvas-bottom-right", ".app-header"]
        .map((selector) => {
          // Comment pins live beside the canvas, outside the chrome.
          const scope = selector === ".app-header" ? shell : selector === ".canvas-comment-pins" ? host.parentElement : chromeRef.current;
          const root = scope?.querySelector(selector) ?? null;
          return {
            root,
            focus: () => {
              const target = (selector === ".creation-rail" ? root?.querySelector<HTMLElement>('.rail-tool[aria-pressed="true"]:not(:disabled)') : null) ??
                root?.querySelector<HTMLElement>('button:not(:disabled), a[href], summary, select:not(:disabled)');
              return focusOrFallback(target);
            },
          };
        }),
    ].filter((region) => region.root);
    const active = document.activeElement;
    const sticky = active?.closest(".sticky-text-editor");
    const current = regions.findIndex((region) => region.root === host
      ? host.contains(active) || Boolean(sticky) : region.root?.contains(active));
    for (let step = 1; step <= regions.length; step++) {
      const region = regions[(Math.max(0, current) + direction * step + regions.length * 2) % regions.length];
      if (region.focus()) return;
    }
  };
  const [hint, setHint] = useState("");
  const hintTimer = useRef(0);
  const flashHint = (text: string) => {
    setHint(text);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(""), 2200);
  };
  useEffect(() => () => window.clearTimeout(hintTimer.current), []);
  const contextPoint = useRef<{ x: number; y: number } | null>(null);
  const selectionBeforeMenu = useRef<string[]>([]);
  const openContextMenuRef = useRef<(point: { x: number; y: number } | null) => void>(() => undefined);
  openContextMenuRef.current = (point) => {
    setPalette(null);
    setTextMenu(null);
    setZoomMenu(false);
    setNavigation(null);
    if (point) controller.selectForContextMenu(point.x, point.y, selectionBeforeMenu.current);
    // From the keyboard, open beside the selection (or mid-view on empty canvas).
    const selection = controller.state().selection;
    const bounds = unionView(selection.map((item) => controller.viewBounds(item.id)));
    // Beside the selection's right edge, so its handles stay uncovered (the
    // menu flips to the left edge when there is no room).
    const at = point ?? (bounds
      ? { x: Math.min(host.clientWidth - 24, Math.max(24, bounds.x + bounds.w + 30)), y: Math.min(host.clientHeight - 24, Math.max(24, bounds.y)) }
      : { x: host.clientWidth / 2, y: host.clientHeight / 2 });
    contextPoint.current = at;
    const key = Date.now();
    setContextMenu({ ...at, key, selection: controller.state().selection });
    // Best effort: when the browser lets us read the clipboard without a
    // prompt, say so if there is nothing to paste.
    void clipboardIsEmpty().then((clipboardEmpty) => {
      if (clipboardEmpty) setContextMenu((menu) => (menu?.key === key ? { ...menu, clipboardEmpty } : menu));
    });
  };
  useEffect(() => {
    const menu = (event: MouseEvent) => {
      const path = event.composedPath();
      // Text being written keeps the browser's menu (spelling, paste).
      if (path.some((target) => target instanceof Element &&
          (target.matches('input, textarea, [contenteditable="true"]') || target.closest?.(".sticky-text-editor, .canvas-chrome button")))) return;
      if (!(event.target instanceof Node) || !host.contains(event.target) || controller.isEditing()) return;
      const point = canvasPointAt(host, { x: event.clientX, y: event.clientY });
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      openContextMenuRef.current(point);
    };
    // The engine narrows a multi-selection to the pressed object on any
    // press. A secondary press inside the selection is for its menu, so keep
    // that press from the engine and the whole selection stays.
    let held: number | null = null;
    const press = (event: PointerEvent) => {
      // Ctrl+click is a secondary click on a Mac only; elsewhere it is an
      // ordinary press (Ctrl+drag) the engine must receive.
      if (!(event.button === 2 || (IS_MAC && event.button === 0 && event.ctrlKey))) return;
      selectionBeforeMenu.current = controller.state().selection.map((item) => item.id);
      const point = canvasPointAt(host, { x: event.clientX, y: event.clientY });
      // Right presses go to board navigation (which keeps them from the
      // engine); a Mac Ctrl+click must be kept from the engine here.
      if (event.button === 0 && point && selectionBeforeMenu.current.length > 1 && controller.selectionContains(point.x, point.y)) {
        held = event.pointerId;
        event.stopPropagation();
      }
    };
    const release = (event: PointerEvent) => {
      if (held === null || event.pointerId !== held) return;
      held = null;
      event.stopPropagation();
    };
    host.addEventListener("pointerdown", press, true);
    host.addEventListener("pointerup", release, true);
    host.addEventListener("contextmenu", menu);
    return () => {
      host.removeEventListener("pointerdown", press, true);
      host.removeEventListener("pointerup", release, true);
      host.removeEventListener("contextmenu", menu);
    };
  }, [host, controller]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const path = event.composedPath();
      const inDialog = path.some((target) => target instanceof Element && target.matches('[role="dialog"]'));
      const typing = path.some((target) => target instanceof Element &&
        target.matches('input, textarea, select, [contenteditable="true"]'));
      // The engine's text, shape-label and connector-label editors only end
      // on blur; its Escape just cleared the selection, leaving the caret in
      // the text so the next keys (S, Enter…) were typed into it. Escape now
      // ends that edit like a note's: the object stays selected and the next
      // Escape clears the selection.
      if (event.key === "Escape" && !modal && !event.isComposing &&
          path.some((target) => target instanceof HTMLElement && /^EDGELESS-[A-Z-]+-EDITOR$/u.test(target.tagName))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void controller.exitNativeEditing().then(() => focusCanvas(host));
        return;
      }
      // Region cycling works from anywhere on the board page, including menus.
      if (event.key === "F6" && !event.metaKey && !event.ctrlKey && !event.altKey && !modal && !inDialog) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cycleRegionRef.current(event.shiftKey ? -1 : 1);
        return;
      }
      // Undo and redo from anywhere on the board page except text fields and
      // dialogs - including while a toolbar button or the canvas frame has
      // focus, where the engine never saw them.
      const undoKey = event.key.toLowerCase();
      const undoCommand = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (undoCommand && !event.altKey && !typing && !modal && !inDialog && !controller.isEditing() &&
          (undoKey === "z" || (!IS_MAC && undoKey === "y" && !event.shiftKey))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (undoKey === "y" || event.shiftKey) controller.redo();
        else controller.undo();
        return;
      }
      if (path.some(target => target instanceof HTMLElement && target.dataset.popover === "open")) return;
      // Zoom: ⌘/Ctrl + = − 0 everywhere on the board (also while writing),
      // Shift+0/1/2 when not typing. The engine's Alt+0/1/2 use the same steps.
      const zoomCommand = zoomCommandForKey(event, IS_MAC) ??
        (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
          ? ({ Digit0: "reset", Digit1: "fit", Digit2: "selection" } as Record<string, ZoomCommand>)[event.code] ?? null
          : null);
      if (zoomCommand && !modal && !inDialog && (!typing || event.metaKey || event.ctrlKey) &&
          !(event.target as Element | null)?.closest?.(".collaboration-panel, .history-panel, .share-dialog")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        runZoomRef.current(zoomCommand);
        return;
      }
      // Toolbar controls own Enter/Space, but Escape cancels placement even
      // while a rail button still has focus.
      if (
        event.key === "Escape" &&
        !modal &&
        path.some(
          (target) =>
            target instanceof Element &&
            target.matches(
              ".creation-rail, .tool-palette, .canvas-zoom, .canvas-navigator",
            ),
        ) &&
        !path.some(
          (target) =>
            target instanceof Element &&
            target.matches('input, textarea, select, [contenteditable="true"]'),
        )
      ) {
        drag.cancel();
        dragIntent.current = null;
        event.preventDefault();
        event.stopImmediatePropagation();
        setPalette(null);
        setNavigation(null);
        setZoomMenu(false);
        setTextMenu(null);
        if (!controller.isEditing())
          controller.selectTool("select", optionsRef.current);
        focusCanvas(host);
        return;
      }
      const onCanvas = path.includes(host) && !typing && !modal;
      // Tab walks through objects on the board in reading order; past the
      // last (or first) object it continues to the tool rail (or header).
      if (event.key === "Tab" && onCanvas && !event.metaKey && !event.ctrlKey && !event.altKey && !controller.isEditing()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!controller.selectAdjacent(event.shiftKey ? -1 : 1)) cycleRegionRef.current(event.shiftKey ? -1 : 1);
        else {
          // The engine's own keys (arrows nudge, Delete) need its focus.
          focusCanvas(host);
          markKeyboardFocus(true);
        }
        return;
      }
      // Also when nothing has focus yet (a freshly opened board).
      const unfocused = !typing && !modal && (document.activeElement === document.body || document.activeElement === null);
      if ((onCanvas || unfocused) && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openContextMenuRef.current(null);
        return;
      }
      // Tool letters and "?" still work while a board control (a rail tool,
      // zoom, undo) has focus; Enter and Space stay with the control.
      const fromChrome = !typing && event.key.length === 1 && event.key !== " " &&
        (event.key === "?" || TOOL_KEYS[event.key.toLowerCase()] !== undefined) &&
        path.some((target) => target instanceof HTMLButtonElement && Boolean(chromeRef.current?.contains(target)) &&
          !target.closest('[role="dialog"], [role="menu"], .sticky-selection-actions, .tool-palette'));
      if (
        !fromChrome &&
        path.some(
          (target) =>
            target instanceof Element &&
            (target.matches(
              'input, textarea, select, button, a[href], summary, [role="button"], [role="menuitem"], [role="checkbox"], [role="tab"], [contenteditable="true"]',
            ) ||
              target.closest('[role="dialog"]')),
        )
      )
        return;
      // Board panels and app controls own their typing and key handling.
      const target = event.target as HTMLElement;
      if (
        target.closest(
          ".collaboration-panel, .app-header, .history-panel, .share-dialog",
        )
      )
        return;
      if (modal) return;
      const letter = event.key.toLowerCase();
      const command = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (command && !event.altKey && !event.shiftKey && !controller.isEditing()) {
        if (letter === "k") {
          event.preventDefault(); event.stopImmediatePropagation();
          setPalette(null); setNavigation(null); setModal("actions");
          return;
        }
        if (event.key === "Enter" && !event.repeat && controller.addAdjacentNote()) {
          event.preventDefault(); event.stopImmediatePropagation(); return;
        }
      }
      if ((IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
          letter === "d" && !event.altKey && !event.shiftKey && !controller.isEditing() &&
          controller.editable() && controller.state().selection.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) void controller.duplicateSelection().catch(() => setNotice("Could not duplicate the selection. Try again."));
        return;
      }
      if ((event.metaKey || event.ctrlKey) && letter === "f") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setNavigation("search");
        setPalette(null);
        return;
      }
      const shortcutMark = markForShortcut(event);
      if (shortcutMark && !controller.isEditing()) {
        const selection = controller.state().selection;
        if (
          selection.some((item) => item.simpleSticky) &&
          selection.every((item) => item.simpleSticky || item.kind === "connector")
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          controller.toggleTextMark(shortcutMark);
          return;
        }
      }
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.shiftKey && letter === "l")
      )
        return;
      // Arrow keys nudge the selection as undoable steps (the engine's own
      // nudge bypassed history).
      const nudge = nudgeDelta(event.key, event.shiftKey);
      if (nudge && !event.metaKey && !event.ctrlKey && !event.altKey && controller.state().selection.length &&
          !controller.isEditing() && controller.nudge(...nudge)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      // Layer order comes before type-to-edit, which would otherwise write
      // "]" into a selected note or replace a shape's label with it.
      if ((event.key === "]" || event.key === "[") && !event.metaKey && !event.ctrlKey && !event.altKey &&
          controller.editable() && controller.state().selection.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        controller.reorderSelection(event.key === "]" ? "front" : "back");
        return;
      }
      // With the note or shape tool armed, Enter places one in the middle of
      // the view (and starts writing in a note): creation without a pointer.
      const armed = controller.state().tool;
      if (event.key === "Enter" && !event.shiftKey && !event.repeat && controller.editable() &&
          (armed === "sticky" || armed === "shape" || armed === "text")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPalette(null);
        controller.placeTool(armed, host.clientWidth / 2, host.clientHeight / 2, optionsRef.current, { findSpace: true });
        return;
      }
      // A selected object is not a text field: single keys are shortcuts
      // (tools, ?, zoom, layer order) and Enter (or a double-click) starts
      // writing at the end of its text. New notes still open ready to type.
      if (
        !fromChrome && event.key === "Enter" && !event.shiftKey && !event.isComposing &&
        controller.state().selection.length === 1 &&
        (controller.editSelectedNote() || (!controller.isEditing() &&
          (controller.editSelectedShape() || controller.editSelectedText())))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPalette(null);
        return;
      }
      if (controller.isEditing() && event.key !== "Escape") return;
      if (event.shiftKey && event.key !== "?") return;
      // Rich document notes keep the engine's own Enter handling.
      if (
        controller.state().selection.length === 1 &&
        controller.state().selection[0].kind === "note" &&
        !controller.state().selection[0].simpleSticky &&
        event.key === "Enter"
      )
        return;
      const tools = TOOL_KEYS;
      // C comments (the rail's Comment button), for commenters too.
      if (letter === "c" && commentRef.current.can && !event.repeat) {
        event.preventDefault();
        event.stopImmediatePropagation();
        commentRef.current.open();
        return;
      }
      if (tools[letter]) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const next =
          letter === "r"
            ? { ...optionsRef.current, shape: "rect" as ShapeName }
            : letter === "o"
              ? { ...optionsRef.current, shape: "ellipse" as ShapeName }
              : optionsRef.current;
        setOptions(next);
        useTool(tools[letter], next);
      } else if (event.key === "?" || event.key === "F1") {
        event.preventDefault();
        setModal("help");
      } else if (event.key === "Escape") {
        drag.cancel();
        dragIntent.current = null;
        setPalette(null);
        setNavigation(null);
        setZoomMenu(false);
        setTextMenu(null);
        // First Escape returns to Select; the next one clears the selection,
        // also when focus is on the board's frame rather than the engine.
        if (!controller.isEditing()) {
          if (controller.state().tool === "select") controller.clearSelection();
          else controller.selectTool("select", optionsRef.current);
        }
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [controller, modal, host]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (chromeRef.current?.contains(event.target as Node)) return;
      setPalette(null);
      setZoomMenu(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const editable = controller.editable();
  useEffect(() => {
    if (!editable) {
      drag.cancel();
      setPlacement(null);
      setConnectionPreview(null);
      setPalette(null);
      setModal((current) => (current === "help" || current === "actions" ? current : null));
    }
  }, [editable]);
  const lines = bulk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 100);
  const matches = query.trim()
    ? state.items.filter((item) =>
        item.text.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : [];
  const frames = state.items.filter((item) => item.kind === "frame");
  const arrangeableSelection = state.selection.filter(item => item.arrangeable);
  const activeSearchIndex = matches.findIndex(item => item.id === activeSearchId);
  const searchPageSize = 50;
  const searchPageStart = Math.floor(Math.max(0, activeSearchIndex) / searchPageSize) * searchPageSize;
  const visibleMatches = matches.slice(searchPageStart, searchPageStart + searchPageSize);
  const selectSearchResult = (id: string) => { setActiveSearchId(id); controller.select(id); };
  const stepSearch = (direction: number) => {
    if (!matches.length) return;
    const current = activeSearchIndex;
    const next = current < 0 ? (direction > 0 ? 0 : matches.length - 1) :
      (current + direction + matches.length) % matches.length;
    selectSearchResult(matches[next].id);
  };
  useEffect(() => {
    chromeRef.current?.querySelector('.navigator-list [aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeSearchId, searchPageStart, navigation]);
  const stickySelection = state.selection.filter((item) => item.simpleSticky);
  // A box selection also picks up the arrows between notes, so notes plus
  // connectors still get the note toolbar. Its actions apply to the notes.
  const noteSelection =
    stickySelection.length > 0 &&
    state.selection.every(
      (item) => item.simpleSticky || item.kind === "connector",
    );
  const stickyBounds = noteSelection
    ? unionView(stickySelection.map((note) => controller.viewBounds(note.id)))
    : null;
  // Other selections keep the engine's toolbar, which has its own Align
  // menu; the right-click menu offers the full set of arrangements.
  // Shapes, connectors, text, images, frames, groups and mixed selections
  // get the product toolbar too; only uncovered objects keep the engine's.
  const elementKind = editable && !noteSelection && !state.editing && !controller.isEditing() && !engineToolbar
    ? elementToolbarKind(state.selection) : null;
  const elementBounds = elementKind ? unionView(state.selection.map((item) => controller.viewBounds(item.id))) : null;
  const toolbarTarget = stickyBounds ?? elementBounds;
  const small = host.clientWidth <= 600;
  // Everything the toolbar must avoid. Measuring walks the board's DOM, so
  // results are reused until the selection moves, the view changes or a
  // panel opens; typing in a note never re-measures.
  const [chromeRevision, setChromeRevision] = useState(0);
  useEffect(() => {
    const workspace = host.closest(".board-workspace");
    const shell = host.closest(".app-shell");
    const bump = () => setChromeRevision((value) => value + 1);
    const observer = new MutationObserver(bump);
    if (workspace) observer.observe(workspace, { childList: true, attributes: true, attributeFilter: ["class"] });
    if (shell) observer.observe(shell, { childList: true });
    window.addEventListener("resize", bump);
    return () => { observer.disconnect(); window.removeEventListener("resize", bump); };
  }, [host]);
  // Fixed chrome only moves when panels, menus or the window change, so it
  // is measured once per such change, not per pan frame.
  const chromeCache = useRef<{ key: string; obstacles: Rect[]; right: number } | null>(null);
  const titleCache = useRef<{ key: string; offsets: Map<string, Rect> } | null>(null);
  const relativeTo = (origin: DOMRect) => (rect: DOMRect): Rect =>
    ({ x: rect.left - origin.left, y: rect.top - origin.top, w: rect.width, h: rect.height });
  const measuredChrome = () => {
    const key = [chromeRevision, navigation, palette, utilitiesDock?.top].join("|");
    if (chromeCache.current?.key !== key) {
      const relative = relativeTo(host.getBoundingClientRect());
      const shell = host.closest(".app-shell") ?? document;
      chromeCache.current = {
        key,
        right: canvasRight(),
        obstacles: [
          ...Array.from(shell.querySelectorAll(".app-header .board-heading, .app-header .header-actions, .follow-banner"), (element) => relative(element.getBoundingClientRect())),
          ...Array.from(chromeRef.current?.querySelectorAll(".creation-rail, .canvas-utilities, .canvas-history, .canvas-bottom-right, .canvas-navigator, .tool-palette") ?? [], (element) => relative(element.getBoundingClientRect())),
        ].filter((rect) => rect.w > 0 && rect.h > 0),
      };
    }
    return chromeCache.current;
  };
  /** Frame title labels, which sit just above each frame where a toolbar
   * would go. Their offset from the frame is measured once per frame list
   * and zoom; while panning they follow the frames' model positions. */
  const frameTitleRects = (): Rect[] => {
    const frames = state.items.filter((item) => item.kind === "frame");
    if (!frames.length) return [];
    const key = frames.map((frame) => `${frame.id}:${frame.text}:${Math.round(frame.w)}`).join("|") + "|" + state.zoom.toFixed(2);
    if (titleCache.current?.key !== key) {
      const relative = relativeTo(host.getBoundingClientRect());
      const titles = frameTitles(host).map((element) => relative(element.getBoundingClientRect())).filter((rect) => rect.w > 0);
      const offsets = new Map<string, Rect>();
      for (const frame of frames) {
        const view = controller.viewBounds(frame.id);
        const title = view && titles.find((rect) => Math.abs(rect.x - view.x) < 48 && rect.y <= view.y + 4 && rect.y >= view.y - 96);
        if (view && title) offsets.set(frame.id, { x: title.x - view.x, y: title.y - view.y, w: title.w, h: title.h });
      }
      titleCache.current = { key, offsets };
    }
    return frames.flatMap((frame) => {
      const view = controller.viewBounds(frame.id);
      if (!view) return [];
      // Unmeasured titles (off screen when measured) get the usual size.
      const offset = titleCache.current!.offsets.get(frame.id) ?? { x: 0, y: -34, w: Math.min(view.w, 240), h: 30 };
      return [{ x: view.x + offset.x, y: view.y + offset.y, w: offset.w, h: offset.h }];
    });
  };
  /** Right edge of the visible canvas: side panels overlay it on desktop. */
  const canvasRight = () => {
    const origin = host.getBoundingClientRect();
    const panels = Array.from(host.closest(".app-shell")?.querySelectorAll(".collaboration-panel, .history-panel") ?? [],
      (panel) => panel.getBoundingClientRect().left - origin.left).filter((left) => left > host.clientWidth / 2 && left < host.clientWidth);
    return Math.min(host.clientWidth, ...panels);
  };
  /** Objects just above or below the selection, whose labels a toolbar
   * would cover; computed from model positions, no DOM reads. */
  const nearbyObjects = (target: Rect): Rect[] => {
    const band = { top: target.y - stickyBarSize.h - 60, bottom: target.y + target.h + stickyBarSize.h + 60 };
    const selected = new Set(state.selection.map((item) => item.id));
    const result: Rect[] = [];
    for (const item of state.items) {
      if (selected.has(item.id) || item.kind === "frame" || item.kind === "connector" || item.kind === "group") continue;
      const view = controller.toViewBox(item);
      if (view.y > band.bottom || view.y + view.h < band.top || view.x > host.clientWidth || view.x + view.w < 0) continue;
      result.push(view);
      if (result.length > 40) break;
    }
    return result;
  };
  const singleWithHandles = stickySelection.length === 1 && state.selection.length === 1 && !stickySelection[0].locked;
  const toolbarPlacement = toolbarTarget && !small
    ? placeToolbar({
          target: toolbarTarget,
          size: stickyBarSize,
          bounds: { x: 8, y: 8, w: measuredChrome().right - 16, h: host.clientHeight - 16 },
          obstacles: [...measuredChrome().obstacles, ...frameTitleRects()],
          softObstacles: nearbyObjects(toolbarTarget),
          gap: 12,
          // The quick-connect "+" handles sit 14px outside a single note.
          handleClearance: singleWithHandles && !state.editing ? 18 : 0,
          menuRoom: textMenu === "arrange" ? 150 : 56,
      })
    : null;
  const stickyBarStyle = toolbarPlacement
    ? { top: toolbarPlacement.y, left: toolbarPlacement.x, bottom: "auto", transform: "none" }
    : undefined;
  // Our quick-connect handles around one note, skipping any that would sit
  // under the board chrome. On a tiny, zoomed-out note they would bury it.
  const connectHandles = editable && state.tool === "select" && !state.editing && stickyBounds &&
    stickySelection.length === 1 && state.selection.length === 1 && !stickySelection[0].locked && stickyBounds.w >= 72
    ? (["right", "down", "left", "up"] as Direction[]).flatMap((direction) => {
        const [px, py] = CONNECTION_PORTS[direction].source;
        const x = stickyBounds.x + stickyBounds.w * px + (direction === "right" ? 14 : direction === "left" ? -14 : 0);
        const y = stickyBounds.y + stickyBounds.h * py + (direction === "down" ? 14 : direction === "up" ? -14 : 0);
        return x < 80 || x > host.clientWidth - 18 || y < 18 || y > host.clientHeight - 72 ? [] : [{ direction, x, y }];
      })
    : [];
  // The engine's auto-complete handles are always hidden: around notes they
  // duplicated ours (and floated over neighbours on small notes), around
  // shapes, frames and multi-selections they showed as stray arrows. Notes
  // too small for our handles still connect with "Next step".
  const hideEngineHandles = true;
  const modeHint: string | null = (hint ? hint : !editable
          ? (canComment ? "You can comment · press C, or right-click where you want to comment" : "View only")
          : state.editing
            ? `Esc to finish · Tab or ${IS_MAC ? "⌘" : "Ctrl+"}Enter for the next note`
          : state.tool === "select" && state.selection.length === 1 && state.selection[0].simpleSticky && !state.selection[0].locked
            ? `Click again or press Enter to write · ${MOD}D to duplicate`
          : state.tool === "select" && state.selection.length > 1
            ? (noteSelection
              ? `${state.selection.length} selected · Arrange in the toolbar, or right-click for more`
              : `${state.selection.length} selected · Align in the toolbar, or right-click to arrange`)
          : state.tool === "sticky"
            ? "Click to place a sticky note · Enter adds one in the middle"
            : state.tool === "connector"
              ? "Drag between two objects to connect them"
              : state.tool === "hand"
                ? "Drag to move around the board"
                : state.tool === "frame"
                  ? "Drag around an area to add a frame"
                  : state.tool === "shape"
                    ? "Click or drag to add a shape · Enter adds one in the middle"
                    : null);
  useLayoutEffect(() => {
    // The mode hint sits between the history and zoom bars; when a side panel
    // pushes those together, hide it rather than letting it run underneath.
    // Measured only when the hint or the chrome changes, never per frame.
    const hintElement = chromeRef.current?.querySelector<HTMLElement>(".canvas-mode-hint");
    if (!hintElement) return;
    hintElement.classList.remove("hint-blocked");
    const rect = hintElement.getBoundingClientRect();
    const blocked = Array.from(chromeRef.current?.querySelectorAll(".canvas-bottom-right, .canvas-history") ?? [])
      .some((element) => { const other = element.getBoundingClientRect(); return rect.left < other.right + 12 && rect.right + 12 > other.left; });
    hintElement.classList.toggle("hint-blocked", blocked && rect.width > 0);
  }, [modeHint, narrow, chromeRevision]);
  // The toolbar's own size, observed rather than read on every render.
  const toolbarShown = (noteSelection || Boolean(elementKind)) && editable;
  useLayoutEffect(() => {
    const bar = stickyBarRef.current;
    if (!toolbarShown || !bar) return;
    const measure = () => {
      // A phone toolbar that wraps gets even rows rather than a straggler.
      const style = getComputedStyle(bar);
      const extra = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) +
        parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      const content = small
        ? balancedRowWidth(Array.from(bar.children, (child) => (child as HTMLElement).offsetWidth),
            parseFloat(style.columnGap) || 0, host.clientWidth - 16 - extra)
        : null;
      const maxWidth = content === null ? "" : `${content + extra}px`;
      if (bar.style.maxWidth !== maxWidth) bar.style.maxWidth = maxWidth;
      const next = { w: bar.offsetWidth, h: bar.offsetHeight };
      setStickyBarSize((size) =>
        Math.abs(next.w - size.w) > 1 || Math.abs(next.h - size.h) > 1 ? next : size);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [toolbarShown, elementKind, noteSelection, small]);
  // On a phone, writing in a note shown at a fraction of its size is
  // unreadable: bring it up to a legible size when editing starts.
  const editingId = state.editing?.id;
  useEffect(() => {
    if (!editingId || host.clientWidth > 600) return;
    const bounds = controller.viewBounds(editingId);
    if (bounds && bounds.w < host.clientWidth * 0.45) controller.fit([editingId]);
  }, [editingId, controller, host]);
  const selectionKey = state.selection.map((item) => item.id).join(",");
  useEffect(() => setEngineToolbar(false), [selectionKey]);
  useEffect(() => setTextMenu(null), [selectionKey]);
  const stickyCss = useMemo(
    () =>
      stickyTextCss(
        state.items
          .filter((item) => item.kind === "note")
          .map((item) => ({ id: item.id, style: item.textStyle })),
      ),
    [state.items],
  );
  const notesLocked = stickySelection.every((note) => note.locked);
  // Selected words while editing; otherwise styles apply to whole notes.
  const textTarget = () => {
    const inline = inlineRef.current;
    if (!inline) return null;
    // The editor syncs its range a frame after the browser selection moves,
    // so read the live selection when it is inside the note.
    const selection = document.getSelection();
    const live =
      selection?.rangeCount && inline.rootElement?.contains(selection.anchorNode)
        ? inline.toInlineRange(selection.getRangeAt(0))
        : null;
    const range = live ?? inline.getInlineRange() ?? lastRange.current;
    return range && range.length > 0 ? { inline, range } : null;
  };
  const markActive = (mark: TextMark) => {
    const target = textTarget();
    return target
      ? Boolean(target.inline.getFormat(target.range)[mark])
      : stickySelection.length > 0 && stickySelection.every((note) => note.marks[mark]);
  };
  const toggleMark = (mark: TextMark) => {
    const target = textTarget();
    if (!target) return controller.toggleTextMark(mark);
    const on = !target.inline.getFormat(target.range)[mark];
    target.inline.formatText(target.range, { [mark]: on ? true : null });
    target.inline.setInlineRange(target.range);
    setInlineVersion((version) => version + 1);
  };
  const target = textTarget();
  const textColor = target
    ? (target.inline.getFormat(target.range).color ?? null)
    : stickySelection.every((note) => note.textColor === stickySelection[0]?.textColor)
      ? (stickySelection[0]?.textColor ?? null)
      : undefined;
  /** Put the caret back where it was in the note being written, if any. */
  const returnToEditor = () => {
    const inline = inlineRef.current;
    const root = inline?.rootElement;
    if (!inline || !root?.isConnected || !controller.state().editing) return false;
    root.focus({ preventScroll: true });
    if (lastRange.current) inline.setInlineRange(lastRange.current);
    else inline.focusEnd();
    return true;
  };
  /** Close a toolbar menu after a choice: back to the text when writing,
   * otherwise to the button that opened the menu. */
  const closeMenu = () => {
    const trigger = textMenu ? menuTriggers[textMenu].current : null;
    setTextMenu(null);
    if (!returnToEditor()) focusOrFallback(trigger);
  };
  const arrangeMenu = () => {
    const blocked = state.selection.filter((item) => !item.arrangeable && item.kind !== "connector").length;
    return (
      <div className="sticky-text-menu">
        <button
          className="canvas-icon-button small"
          type="button"
          ref={menuTriggers.arrange}
          aria-label="Arrange selection"
          aria-expanded={textMenu === "arrange"}
          data-tip="Arrange"
          onClick={() => setTextMenu((menu) => (menu === "arrange" ? null : "arrange"))}
        >
          <Icon name="arrange" />
        </button>
        {textMenu === "arrange" ? (
          <div ref={textPanelRef} className="sticky-text-popover arrange-popover" role="group" aria-label="Arrange selection">
            <div className="arrange-grid">
              {ARRANGE_ORDER.map((action) => (
                <button
                  key={action}
                  type="button"
                  aria-label={ARRANGEMENTS[action]}
                  data-tip={arrangeableSelection.length < arrangeMinimum(action)
                    ? `${ARRANGEMENTS[action]} · needs ${arrangeMinimum(action)} or more`
                    : ARRANGEMENTS[action]}
                  disabled={arrangeableSelection.length < arrangeMinimum(action)}
                  onClick={() => controller.arrange(action)}
                >
                  <UiIcon name={action === "grid" ? "arrange" : action} className="canvas-icon" />
                </button>
              ))}
            </div>
            {blocked > 0 ? (
              <p className="arrange-note">
                {blocked === 1 ? "1 locked or grouped object stays in place." : `${blocked} locked or grouped objects stay in place.`}
              </p>
            ) : null}
            <button
              type="button"
              className="arrange-group"
              disabled={state.selection.some((item) => item.locked)}
              onClick={() => { controller.groupSelection(); closeMenu(); }}
            >
              Group selection <kbd>{MOD}G</kbd>
            </button>
          </div>
        ) : null}
      </div>
    );
  };
  const applyTextColor = (color: string | null) => {
    const current = textTarget();
    if (current) {
      current.inline.formatText(current.range, { color });
      current.inline.setInlineRange(current.range);
      setInlineVersion((version) => version + 1);
    } else controller.setTextColor(color);
    closeMenu();
  };
  const sharedStyle = <K extends keyof StickyTextStyle>(key: K) =>
    stickySelection.every((note) => note.textStyle[key] === stickySelection[0]?.textStyle[key])
      ? stickySelection[0]?.textStyle[key]
      : undefined;
  const applyTextStyle = (patch: Partial<StickyTextStyle>) => {
    controller.setTextStyle(patch);
    // A menu took focus from the editor; return it to the same selection.
    returnToEditor();
  };
  const onEditor = (inline: StickyInlineEditor | null) => {
    rangeSubscription.current?.unsubscribe();
    rangeSubscription.current = null;
    inlineRef.current = inline;
    lastRange.current = null;
    setInlineVersion((version) => version + 1);
    if (!inline) return;
    rangeSubscription.current = inline.slots.inlineRangeSync.subscribe(() => {
      const range = inline.getInlineRange();
      if (range) lastRange.current = range;
      setInlineVersion((version) => version + 1);
    });
  };
  useEffect(() => {
    host.classList.toggle("whiteboard-note-selection", noteSelection);
    host.classList.toggle("whiteboard-product-toolbar", (noteSelection || Boolean(elementKind)) && !engineToolbar);
    // The product draws its own quick-connect handles around notes; hide the
    // engine's duplicates (its selection frame re-renders its shadow root).
    return () => host.classList.remove("whiteboard-note-selection", "whiteboard-product-toolbar");
  }, [host, noteSelection, elementKind, engineToolbar]);
  // The engine creates its selection frame lazily; check on every render,
  // but only search the board for it when the cached one is gone.
  const selectedRect = useRef<Element | null>(null);
  useEffect(() => {
    if (!selectedRect.current?.isConnected) selectedRect.current = host.querySelector("edgeless-selected-rect");
    const rect = selectedRect.current;
    if (!rect) return;
    if (rect.hasAttribute("data-whiteboard-notes") !== hideEngineHandles) rect.toggleAttribute("data-whiteboard-notes", hideEngineHandles);
    if (rect.shadowRoot && !rect.shadowRoot.querySelector("style[data-whiteboard-notes]")) {
      const style = document.createElement("style");
      style.dataset.whiteboardNotes = "";
      style.textContent = ":host([data-whiteboard-notes]) edgeless-auto-complete { display: none !important; }";
      rect.shadowRoot.append(style);
    }
  });
  const mod = IS_MAC ? "⌘" : "Ctrl+";
  const needsEdit = !editable ? "Requires edit access" : undefined;
  const quickActions: QuickAction[] = [
    { id: "note-now", label: "Add sticky note here", keywords: "create new idea", disabled: needsEdit,
      run: () => controller.placeTool("sticky", host.clientWidth / 2, host.clientHeight / 2, optionsRef.current) },
    { id: "next-note", label: "Add next note", keywords: "quick create adjacent brainstorm", shortcut: `${mod}Enter`,
      disabled: needsEdit ?? (state.selection.length !== 1 || !state.selection[0].simpleSticky || state.selection[0].locked ? "Select one unlocked sticky note" : undefined),
      run: () => { controller.addAdjacentNote(); } },
    { id: "duplicate", label: "Duplicate selection", shortcut: `${mod}D`, disabled: needsEdit ?? (!state.selection.length ? "Select an object first" : undefined), run: () => controller.duplicateSelection() },
    { id: "undo", label: "Undo", shortcut: `${mod}Z`, disabled: needsEdit ?? (!state.canUndo ? "Nothing to undo" : undefined), run: controller.undo },
    { id: "redo", label: "Redo", shortcut: IS_MAC ? "⌘⇧Z" : "Ctrl+Y", disabled: needsEdit ?? (!state.canRedo ? "Nothing to redo" : undefined), run: controller.redo },
    { id: "fit-board", label: "Fit board", keywords: "zoom out show everything", shortcut: `${SHIFT}1`, run: () => controller.fit() },
    { id: "fit-selection", label: "Fit selection", keywords: "zoom selected objects", shortcut: `${SHIFT}2`, disabled: !state.selection.length ? "Select an object first" : undefined, run: () => controller.fit(state.selection.map(item => item.id)) },
    { id: "zoom-reset", label: "Zoom to 100%", keywords: "actual size reset", shortcut: `${SHIFT}0`, run: () => controller.zoom(1) },
    { id: "zoom-in", label: "Zoom in", keywords: "magnify closer", shortcut: `${MOD}+`, run: () => controller.zoomStep(1) },
    { id: "zoom-out", label: "Zoom out", keywords: "further away", shortcut: `${MOD}−`, run: () => controller.zoomStep(-1) },
    { id: "front", label: "Bring to front", keywords: "layer order top raise", shortcut: "]", disabled: needsEdit ?? (!state.selection.length ? "Select an object first" : undefined), run: () => controller.reorderSelection("front") },
    { id: "back", label: "Send to back", keywords: "layer order bottom lower", shortcut: "[", disabled: needsEdit ?? (!state.selection.length ? "Select an object first" : undefined), run: () => controller.reorderSelection("back") },
    { id: "find", label: "Find on board", keywords: "search text", shortcut: `${mod}F`, run: () => setNavigation("search") },
    { id: "overview", label: "Board overview", keywords: "map minimap navigate", run: () => setNavigation("map") },
    { id: "frames", label: "Browse frames", keywords: "sections navigate", run: () => setNavigation("frames") },
    { id: "select-all", label: "Select all objects", shortcut: `${mod}A`, run: controller.selectAll },
    ...Object.entries(ARRANGEMENTS).map(([id, label]): QuickAction => ({ id: `arrange-${id}`, label,
      keywords: "arrange organize spacing layout", disabled: needsEdit ?? (arrangeableSelection.length < arrangeMinimum(id as Arrangement) ? `Select ${arrangeMinimum(id as Arrangement)} or more unlocked objects` : undefined),
      run: () => controller.arrange(id as Arrangement) })),
    { id: "group", label: "Group selection", shortcut: `${mod}G`, disabled: needsEdit ?? (state.selection.length < 2 || state.selection.some(item => item.locked) ? "Select two or more unlocked objects" : undefined), run: controller.groupSelection },
    { id: "ungroup", label: "Ungroup selection", shortcut: IS_MAC ? "⌘⇧G" : "Ctrl+Shift+G", disabled: needsEdit ?? (state.selection.length !== 1 || state.selection[0].kind !== "group" || state.selection[0].locked ? "Select one unlocked group" : undefined), run: controller.ungroupSelection },
    { id: "bulk", label: "Add multiple sticky notes", keywords: "bulk paste list brainstorm", disabled: needsEdit, run: () => setModal("bulk") },
    { id: "templates", label: "Browse templates", keywords: "retro kanban workflow brainstorm", disabled: needsEdit, run: () => setModal("templates") },
    { id: "grid", label: grid ? "Hide grid" : "Show grid", keywords: "background dots", run: () => setGrid(value => !value) },
    ...TOOLS.map((tool): QuickAction => ({ id: `tool-${tool.id}`, label: `${tool.label} tool`, shortcut: tool.key,
      disabled: ["select", "hand"].includes(tool.id) ? undefined : needsEdit, run: () => useTool(tool.id) })),
    { id: "help", label: "Keyboard shortcuts", keywords: "help learn", shortcut: "?", run: () => setModal("help") },
  ];
  const runQuickAction = (action: QuickAction) => {
    if (action.disabled) return;
    // Finish dialog cleanup before the action claims focus. A deferred frame
    // can otherwise steal focus from a palette opened for the next command.
    flushSync(() => setModal(null));
    if (!host.isConnected) return;
    focusCanvas(host);
    Promise.resolve().then(() => action.run()).catch(() => setNotice("That action could not be completed. Try again."));
  };
  const runContextAction = (action: ContextMenuAction, selection: CanvasState["selection"]) => {
    const point = contextPoint.current ?? { x: host.clientWidth / 2, y: host.clientHeight / 2 };
    focusCanvas(host);
    const fail = () => setNotice("That action could not be completed. Try again.");
    if (action.startsWith("arrange-")) return controller.arrange(action.slice(8) as Arrangement);
    switch (action) {
      case "edit":
        if (!controller.editSelectedNote()) controller.editSelectedShape();
        return;
      case "comment": {
        const objectId = selection.length === 1 ? selection[0].id : null;
        const [x, y] = controller.toModelPoint(point.x, point.y);
        const place = () => {
          window.dispatchEvent(new CustomEvent("whiteboard-comment-position", { detail: { x, y, objectId } }));
          // The comments panel covers the right of the board; keep the new
          // pin in view beside it.
          const panel = host.closest(".app-shell")?.querySelector(".collaboration-panel")?.getBoundingClientRect();
          const origin = host.getBoundingClientRect();
          const object = objectId ? controller.viewBounds(objectId) : null;
          const pinX = object ? object.x + object.w + 40 : point.x + 32;
          const visibleRight = panel && panel.left - origin.left > host.clientWidth / 2 ? panel.left - origin.left - 24 : host.clientWidth - 24;
          if (pinX > visibleRight) controller.panBy(pinX - visibleRight + 48, 0);
        };
        if (document.querySelector(".collaboration-panel .comment-composer")) place();
        else {
          onComment();
          // The comments panel mounts on the next render; anchor it then.
          requestAnimationFrame(() => requestAnimationFrame(place));
        }
        return;
      }
      case "copy":
        if (!document.execCommand("copy")) fail();
        return;
      case "paste":
        void pasteFromClipboard().catch(() => setNotice(`Your browser blocked pasting from the menu. Press ${MOD}V instead.`));
        return;
      case "duplicate":
        void controller.duplicateSelection().catch(fail);
        return;
      case "front":
      case "back":
        return controller.reorderSelection(action);
      case "group":
        return controller.groupSelection();
      case "ungroup":
        return controller.ungroupSelection();
      case "lock":
        return controller.lockSelection();
      case "rotate":
        return controller.rotateSelection(90);
      case "delete":
        return controller.deleteSelection();
      case "add-sticky": {
        // Keep the whole note in the visible board, clear of the bars.
        const [top, right, bottom, left] = canvasFitPadding(host);
        const half = (208 * state.zoom) / 2;
        const clamp = (value: number, min: number, max: number) => (min > max ? (min + max) / 2 : Math.min(max, Math.max(min, value)));
        return controller.placeTool("sticky",
          clamp(point.x, left + half, host.clientWidth - right - half),
          clamp(point.y, top + half, host.clientHeight - bottom - half), optionsRef.current);
      }
      case "select-all":
        return controller.selectAll();
      case "fit-board":
        return controller.fit();
      case "fit-selection":
        return void controller.fitSelection();
      case "zoom-reset":
        return controller.zoom(1);
      case "grid":
        return setGrid((value) => !value);
    }
  };
  /** True only when the clipboard is readable without asking and empty. */
  const clipboardIsEmpty = async () => {
    try {
      const permission = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
      if (permission?.state !== "granted" || !navigator.clipboard?.read) return !copiedThisSession.current;
      const items = await navigator.clipboard.read();
      return items.every((item) => item.types.length === 0);
    } catch { return !copiedThisSession.current; }
  };
  /** Paste through the engine's own clipboard handling at the menu's point. */
  const pasteFromClipboard = async () => {
    const target = host.querySelector<HTMLElement>("editor-host");
    if (!target || !navigator.clipboard?.read) throw new Error("Clipboard unavailable");
    const data = new DataTransfer();
    for (const entry of await navigator.clipboard.read()) {
      for (const type of entry.types) {
        const blob = await entry.getType(type);
        if (type.startsWith("text/")) data.setData(type, await blob.text());
        else data.items.add(new File([blob], "pasted", { type }));
      }
    }
    if (!data.types.length && !data.items.length) {
      setNotice(`Nothing to paste yet. Copy something first, then press ${MOD}V.`, "info");
      return;
    }
    target.focus({ preventScroll: true });
    target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  };
  const templateCards = [
    {
      id: "brainstorm" as const,
      title: "Brainstorm",
      description: "Collect ideas, explore them, and decide together.",
      columns: ["Ideas", "Explore", "Decide"],
    },
    {
      id: "retro" as const,
      title: "Retrospective",
      description:
        "Review what went well, what needs work, and what to do next.",
      columns: ["Went well", "Could be better", "Next steps"],
    },
    {
      id: "kanban" as const,
      title: "Kanban",
      description: "Track work from To do to Done.",
      columns: ["To do", "In progress", "Done"],
    },
    {
      id: "flow" as const,
      title: "Workflow",
      description: "Map a process with editable stickies and attached arrows.",
      columns: ["Start", "Review", "Decide", "Deliver"],
    },
  ];
  return (
    <div
      className={"canvas-chrome" + (modal ? " canvas-modal-open" : "") + (narrow ? " canvas-narrow" : "")}
      ref={chromeRef}
    >
      {notice ? (
        <div className={"canvas-notice" + (noticeState.tone === "info" ? " info" : "")} role={noticeState.tone === "info" ? "status" : "alert"}>
          <span>{notice}</span>
          <button
            className="canvas-icon-button small"
            type="button"
            aria-label="Dismiss message"
            onClick={() => setNotice("")}
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}
      {/* The text editor is part of the board surface: it lives inside the
          canvas element, below the board chrome, so toolbars and menus stay
          on top of it and clicks on it count as clicks on the canvas. */}
      {state.editing ? createPortal(
        <StickyTextEditor
          key={state.editing.id}
          fittedSize={fittedSizes[state.editing.id]}
          state={state}
          controller={controller}
          host={host}
          onEditor={onEditor}
          onToggleMark={toggleMark}
          dark={dark}
        />,
        host,
      ) : null}
      {placement && editable ? (
        <div
          className="canvas-placement-preview"
          aria-hidden="true"
          style={{
            left: placement.x,
            top: placement.y,
            width: (placement.tool === "sticky" ? 208 : (SHAPE_SIZE[placement.options.shape] ?? SHAPE_SIZE.rect).w) * state.zoom,
            height: (placement.tool === "sticky" ? 208 : (SHAPE_SIZE[placement.options.shape] ?? SHAPE_SIZE.rect).h) * state.zoom,
            background:
              placement.tool === "sticky" ? paperFor(placement.options.color, dark) : undefined,
          }}
        >
          {placement.tool === "shape" ? (
            <svg
              viewBox="0 0 32 32"
              preserveAspectRatio="none"
              fill="var(--surface)"
              stroke="var(--text-secondary)"
              strokeWidth="0.5"
            >
              {
                SHAPES.find((shape) => shape.id === placement.options.shape)
                  ?.content
              }
            </svg>
          ) : null}
        </div>
      ) : null}
      {connectionPreview ? (
        <ConnectionPreview
          preview={connectionPreview}
          controller={controller}
        />
      ) : null}
      {/* Locked objects say so where they are, not only in the toolbar. */}
      {state.selection.filter((item) => item.locked).slice(0, 20).map((item) => {
        const bounds = controller.viewBounds(item.id);
        return bounds ? (
          <span key={item.id} className="lock-badge" style={{ left: bounds.x + bounds.w - 10, top: bounds.y - 10 }} title="Locked" aria-hidden="true">
            <Icon name="lock" />
          </span>
        ) : null;
      })}
      {connectHandles.length ? (
        <div className="sticky-connectors" aria-label="Sticky connections">
          {connectHandles.map(({ direction, x, y }) => {
            const source = stickySelection[0].id;
            return (
              <button
                key={direction}
                type="button"
                className={"sticky-connect-handle " + direction}
                style={{ left: x, top: y }}
                aria-label={"Add connected sticky " + direction}
                title="Click to add a note · drag to connect"
                onPointerEnter={() =>
                  setConnectionPreview(
                    controller.connectionPreview(source, direction),
                  )
                }
                onPointerLeave={() => setConnectionPreview(null)}
                onPointerDown={(event) => {
                  dragIntent.current = { source, direction };
                  drag.start(event);
                }}
                onClick={() => {
                  dragIntent.current = null;
                  setConnectionPreview(null);
                  if (!drag.consumeClick())
                    controller.connectNext(direction, source);
                }}
              >
                <Icon name="plus" />
              </button>
            );
          })}
        </div>
      ) : null}
      <button type="button" className="rail-more" aria-label="Show more tools" data-tip="More tools" tabIndex={-1}
        onClick={() => railRef.current?.scrollBy({ left: railRef.current.clientWidth * 0.8, behavior: "smooth" })}>
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>
      </button>
      <nav className="creation-rail" aria-label="Whiteboard tools" ref={railRef} onScroll={updateRailOverflow}>
        {TOOLS.map((tool, index) => (
          <div
            key={tool.id}
            className={"rail-tool-row" + (index === 2 ? " rail-divider" : "")}
          >
            <button
              type="button"
              className={
                "rail-tool" + (state.tool === tool.id ? " selected" : "")
              }
              aria-label={tool.label}
              aria-pressed={state.tool === tool.id}
              disabled={!editable && tool.id !== "select" && tool.id !== "hand"}
              onPointerDown={(event) => {
                if (!editable || (tool.id !== "sticky" && tool.id !== "shape"))
                  return;
                dragIntent.current = {
                  tool: tool.id,
                  options: optionsRef.current,
                };
                drag.start(event);
              }}
              onClick={() => {
                if (!drag.consumeClick()) useTool(tool.id);
              }}
            >
              {tool.id === "shape" ? (
                <svg
                  className="canvas-icon"
                  viewBox="0 0 32 32"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                >
                  {SHAPES.find((shape) => shape.id === options.shape)?.content}
                </svg>
              ) : tool.id === "sticky" ? (
                <span
                  className="rail-sticky-sample"
                  style={{ background: paperFor(options.color, dark) }}
                >
                  <Icon name="sticky" />
                </span>
              ) : (
                <Icon name={tool.id} />
              )}
              <span className="rail-tooltip">
                {tool.label}
                <kbd>{tool.key}</kbd>
              </span>
            </button>
            {["sticky", "shape", "connector", "pen"].includes(tool.id) ? (
              <button
                type="button"
                ref={palette === tool.id ? paletteTriggerRef : undefined}
                className="rail-options"
                aria-label={tool.label + " options"}
                aria-expanded={palette === tool.id}
                disabled={!editable}
                onClick={() => {
                  const next = palette === tool.id ? null : tool.id;
                  controller.selectTool(tool.id, optionsRef.current);
                  setPalette(next);
                  setNavigation(null);
                }}
              >
                <svg
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="m4 2 4 4-4 4" />
                </svg>
              </button>
            ) : null}
          </div>
        ))}
        <button
          className="rail-tool rail-divider"
          type="button"
          aria-label="Templates"
          disabled={!editable}
          onClick={() => {
            setPalette(null);
            setModal("templates");
          }}
        >
          <Icon name="templates" />
          <span className="rail-tooltip">Templates</span>
        </button>
        <button
          className="rail-tool"
          type="button"
          aria-label="Upload image"
          disabled={!editable}
          onClick={() => uploadRef.current?.click()}
        >
          <Icon name="upload" />
          <span className="rail-tooltip">Upload image</span>
        </button>
        <button
          className="rail-tool"
          type="button"
          aria-label="Add comment"
          disabled={!canComment}
          onClick={onComment}
        >
          <UiIcon name="comment" className="canvas-icon" />
          <span className="rail-tooltip">Comment</span>
        </button>
      </nav>
      <input
        ref={uploadRef}
        type="file"
        accept="image/*"
        className="sr-only"
        aria-label="Choose an image"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void controller
            .uploadImage(file)
            // The new image is selected; the board takes focus so Delete,
            // arrows and shortcuts act on it (not the Upload button).
            .then(() => focusCanvas(host))
            .catch((error) =>
              setNotice(
                error instanceof Error
                  ? error.message
                  : "Image could not be added",
              ),
            );
          event.target.value = "";
        }}
      />
      <div className="canvas-history" role="group" aria-label="Edit history">
        <button
          className="canvas-icon-button"
          type="button"
          aria-label="Undo"
          data-tip={`Undo · ${MOD}Z`}
          disabled={!editable || !state.canUndo}
          onClick={() => controller.undo()}
        >
          <Icon name="undo" />
        </button>
        <button
          className="canvas-icon-button"
          type="button"
          aria-label="Redo"
          data-tip={IS_MAC ? "Redo · ⌘⇧Z" : "Redo · Ctrl+Y"}
          disabled={!editable || !state.canRedo}
          onClick={() => controller.redo()}
        >
          <Icon name="redo" />
        </button>
      </div>
      {palette && editable ? (
        <section ref={palettePanelRef} className="tool-palette" aria-label={palette + " options"}>
          <header>
            <strong>
              {palette === "sticky"
                ? "Sticky notes"
                : palette === "shape"
                  ? "Shapes"
                  : palette === "connector"
                    ? "Connection lines"
                    : "Drawing"}
            </strong>
            <button
              className="canvas-icon-button small"
              type="button"
              aria-label="Close tool options"
              onClick={() => setPalette(null)}
            >
              <Icon name="close" />
            </button>
          </header>
          {palette === "sticky" ? (
            <>
              <Palette
                dark={dark}
                color={options.color}
                onDragStart={(event, color) => {
                  const next = { ...optionsRef.current, color };
                  setOptions(next);
                  dragIntent.current = { tool: "sticky", options: next };
                  drag.start(event);
                }}
                consumeClick={drag.consumeClick}
                onChange={(color) => changeOptions({ color })}
              />
              <p className="palette-hint">
                Click the canvas or drag this tool to add a note.
              </p>
              <button
                className="palette-action"
                type="button"
                onClick={() => {
                  setPalette(null);
                  setModal("bulk");
                }}
              >
                Add multiple notes <Icon name="plus" />
              </button>
            </>
          ) : null}
          {palette === "shape" ? (
            <>
              <div className="shape-grid">
                {SHAPES.map((shape) => (
                  <button
                    type="button"
                    key={shape.id}
                    aria-label={shape.label}
                    aria-pressed={options.shape === shape.id}
                    title={shape.label}
                    onPointerDown={(event) => {
                      dragIntent.current = {
                        tool: "shape",
                        options: { ...optionsRef.current, shape: shape.id },
                      };
                      setOptions(dragIntent.current.options);
                      drag.start(event);
                    }}
                    onClick={() => {
                      if (!drag.consumeClick()) {
                        changeOptions({ shape: shape.id });
                        setPalette(null);
                        focusCanvas(host);
                      }
                    }}
                  >
                    <svg
                      viewBox="0 0 32 32"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      {shape.content}
                    </svg>
                  </button>
                ))}
              </div>
              <p className="palette-hint">Click or drag to draw a shape.</p>
            </>
          ) : null}
          {palette === "connector" ? (
            <>
              <div className="line-choices">
                {[
                  {
                    id: ConnectorMode.Straight,
                    label: "Straight",
                    d: "M4 22 28 10",
                  },
                  {
                    id: ConnectorMode.Orthogonal,
                    label: "Elbow",
                    d: "M4 24h12V8h12",
                  },
                  {
                    id: ConnectorMode.Curve,
                    label: "Curved",
                    d: "M4 24C24 24 8 8 28 8",
                  },
                ].map((line) => (
                  <button
                    type="button"
                    key={line.id}
                    aria-pressed={options.line === line.id}
                    onClick={() => changeOptions({ line: line.id })}
                  >
                    <svg
                      viewBox="0 0 32 32"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                    >
                      <path d={line.d} />
                    </svg>
                    <span>{line.label}</span>
                  </button>
                ))}
              </div>
              <p className="palette-hint">
                Drag between objects. Lines stay attached as you move them.
              </p>
            </>
          ) : null}
          {palette === "pen" || palette === "eraser" ? (
            <>
              <div className="drawing-modes">
                <button
                  type="button"
                  aria-pressed={state.tool === "pen"}
                  onClick={() => useTool("pen")}
                >
                  <Icon name="pen" />
                  Pen
                </button>
                <button
                  type="button"
                  aria-pressed={state.tool === "eraser"}
                  onClick={() => useTool("eraser")}
                >
                  <Icon name="eraser" />
                  Eraser
                </button>
              </div>
              {palette === "pen" ? (
                <>
                  <div className="pen-colors">
                    {[
                      "#27334b",
                      "#4262ff",
                      "#ef6476",
                      "#16a080",
                      "#eead26",
                    ].map((color, index) => (
                      <button
                        type="button"
                        key={color}
                        aria-label={
                          ["Ink", "Blue", "Coral", "Green", "Gold"][index] +
                          " pen"
                        }
                        aria-pressed={options.penColor === color}
                        style={{
                          background:
                            color === "#27334b" ? "var(--text)" : color,
                        }}
                        onClick={() => changeOptions({ penColor: color })}
                      />
                    ))}
                  </div>
                  <label className="pen-width">
                    Stroke width{" "}
                    <select
                      value={options.penWidth}
                      onChange={(event) =>
                        changeOptions({
                          penWidth: Number(
                            event.target.value,
                          ) as CanvasOptions["penWidth"],
                        })
                      }
                    >
                      <option value={2}>Fine</option>
                      <option value={4}>Medium</option>
                      <option value={6}>Bold</option>
                      <option value={12}>Thick</option>
                    </select>
                  </label>
                </>
              ) : (
                <p className="palette-hint">Drag over a drawing to erase it.</p>
              )}
            </>
          ) : null}
        </section>
      ) : null}
      <div
        className="canvas-utilities"
        role="group"
        aria-label="Board navigation"
        ref={utilitiesRef}
        style={utilitiesDock ?? undefined}
      >
        <button className="canvas-icon-button" type="button" aria-label="Quick actions" data-tip={`Quick actions · ${mod}K`}
          onClick={() => { controller.finishEditing(); setPalette(null); setNavigation(null); setModal("actions"); }}>
          <Icon name="commands" />
        </button>
        <button
          className={
            "canvas-icon-button" + (navigation === "search" ? " active" : "")
          }
          type="button"
          aria-label="Find on board"
          aria-pressed={navigation === "search"}
          data-tip={`Find on board · ${MOD}F`}
          onClick={() => {
            setNavigation(navigation === "search" ? null : "search");
            setPalette(null);
          }}
        >
          <Icon name="search" />
        </button>
        <button
          className={
            "canvas-icon-button" + (navigation === "frames" ? " active" : "")
          }
          type="button"
          aria-label="Frames"
          aria-pressed={navigation === "frames"}
          data-tip="Frames"
          onClick={() =>
            setNavigation(navigation === "frames" ? null : "frames")
          }
        >
          <Icon name="frame" />
        </button>
        <button
          className="canvas-icon-button"
          type="button"
          aria-label="Toggle grid"
          aria-pressed={grid}
          data-tip={grid ? "Hide grid" : "Show grid"}
          onClick={() => setGrid((value) => !value)}
        >
          <Icon name="grid" />
        </button>
      </div>
      {stickyCss ? <style>{stickyCss}</style> : null}
      {elementKind && toolbarTarget ? (
        <ElementToolbar
          ref={stickyBarRef}
          kind={elementKind}
          controller={controller}
          dark={dark}
          style={stickyBarStyle}
          side={small ? "above" : toolbarPlacement?.side ?? "below"}
          mod={MOD}
          count={state.selection.length}
          arrange={arrangeMenu()}
          onShowEngineToolbar={() => setEngineToolbar(true)}
          onNotice={setNotice}
          host={host}
        />
      ) : null}
      {noteSelection && editable ? (
        <div
          className="sticky-selection-actions"
          ref={stickyBarRef}
          style={stickyBarStyle}
          // Phones pin the toolbar above the tool rail; its menus open upward.
          data-side={small ? "above" : toolbarPlacement?.side ?? "below"}
          role="toolbar"
          aria-label="Sticky note actions"
          // Keep focus, and the text selection, in the note being edited.
          onMouseDown={(event) => {
            if (!(event.target as Element).closest("select")) event.preventDefault();
          }}
        >
          <div className="sticky-text-menu">
            <button className="canvas-icon-button small" type="button" aria-label="Note color"
              ref={menuTriggers.paper}
              aria-expanded={textMenu === "paper"} data-tip="Note color" disabled={notesLocked}
              onClick={() => setTextMenu(menu => menu === "paper" ? null : "paper")}>
              <span className="paper-color-chip" style={{ background: dark ? stickySelection[0].colorDark : stickySelection[0].color }} />
            </button>
            {textMenu === "paper" ? <div ref={textPanelRef} className="sticky-text-popover paper-colors" role="group" aria-label="Note colors">
              <Palette dark={dark} color={stickySelection[0].color} onChange={color => {
                setOptions(current => ({ ...current, color }));
                controller.colorSelection(color);
                closeMenu();
              }} />
            </div> : null}
          </div>
          <span className="selection-divider" />
          <select
            className="sticky-text-select"
            aria-label="Font"
            title="Font"
            disabled={notesLocked}
            value={sharedStyle("font") ?? ""}
            onChange={(event) =>
              applyTextStyle({ font: event.target.value as StickyTextStyle["font"] })
            }
          >
            {sharedStyle("font") ? null : <option value="" disabled>Mixed</option>}
            {STICKY_FONTS.map((font) => (
              <option key={font.id} value={font.id}>
                {font.name}
              </option>
            ))}
          </select>
          <select
            className="sticky-text-select"
            aria-label="Text size"
            title="Text size"
            disabled={notesLocked}
            value={sharedStyle("size") ?? ""}
            onChange={(event) =>
              applyTextStyle({ size: event.target.value as StickyTextStyle["size"] })
            }
          >
            {sharedStyle("size") ? null : <option value="" disabled>Mixed</option>}
            {STICKY_SIZES.map((size) => (
              <option key={size.id} value={size.id}>
                {size.name}
              </option>
            ))}
          </select>
          <span className="selection-divider" />
          {TEXT_MARKS.map((mark) => (
            <button
              key={mark}
              className="canvas-icon-button small"
              type="button"
              aria-label={MARK_SHORTCUTS[mark].label}
              aria-pressed={markActive(mark)}
              data-tip={`${MARK_SHORTCUTS[mark].label} · ${shortcutLabel(mark)}`}
              disabled={notesLocked}
              onClick={() => toggleMark(mark)}
            >
              <Icon name={mark} />
            </button>
          ))}
          <div className="sticky-text-menu">
            <button
              className="canvas-icon-button small text-color-button"
              type="button"
              aria-label="Text color"
              ref={menuTriggers.textColor}
              aria-expanded={textMenu === "textColor"}
              data-tip="Text color"
              disabled={notesLocked}
              onClick={() =>
                setTextMenu((menu) => (menu === "textColor" ? null : "textColor"))
              }
            >
              <Icon name="textColor" />
              <span
                className="text-color-bar"
                style={{ background: textColor ?? "#303748" }}
              />
            </button>
            {textMenu === "textColor" ? (
              <div ref={textPanelRef} className="sticky-text-popover" role="group" aria-label="Text colors">
                {STICKY_TEXT_COLORS.map((color) => (
                  <button
                    key={color.name}
                    type="button"
                    aria-label={`${color.name} text`}
                    aria-pressed={textColor === color.value}
                    title={color.name}
                    style={{ color: color.value ?? "#303748" }}
                    onClick={() => applyTextColor(color.value)}
                  >
                    A
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="sticky-text-menu">
            <button
              className="canvas-icon-button small"
              type="button"
              aria-label="Text alignment"
              ref={menuTriggers.align}
              aria-expanded={textMenu === "align"}
              data-tip="Text alignment"
              disabled={notesLocked}
              onClick={() => setTextMenu((menu) => (menu === "align" ? null : "align"))}
            >
              <Icon name={ALIGN_ICONS[sharedStyle("align") ?? "left"]} />
            </button>
            {textMenu === "align" ? (
              <div ref={textPanelRef} className="sticky-text-popover" role="group" aria-label="Text alignment">
                {STICKY_ALIGNMENTS.map((align) => (
                  <button
                    key={align.id}
                    type="button"
                    aria-label={align.name}
                    aria-pressed={sharedStyle("align") === align.id}
                    title={align.name}
                    onClick={() => {
                      applyTextStyle({ align: align.id });
                      closeMenu();
                    }}
                  >
                    <Icon name={ALIGN_ICONS[align.id]} />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <span className="selection-divider" />
          {state.selection.length > 1 ? (
            <>
              {arrangeMenu()}
              <span className="selection-divider" />
            </>
          ) : null}
          <button
            className="canvas-icon-button small"
            type="button"
            aria-label="Duplicate selection"
            data-tip={`Duplicate · ${MOD}D`}
            onClick={() => void controller.duplicateSelection()}
          >
            <Icon name="duplicate" />
          </button>
          <button
            className="canvas-icon-button small"
            type="button"
            aria-label={notesLocked ? "Unlock notes" : "Lock notes"}
            aria-pressed={notesLocked}
            data-tip={notesLocked ? "Unlock" : "Lock"}
            onClick={() => controller.lockSelection()}
          >
            <Icon name="lock" />
          </button>
          {state.selection.length === 1 && !stickySelection[0].locked ? (
            <>
              <span className="selection-divider" />
              <button
                type="button"
                className="next-step-button"
                data-tip="Add a connected step to the right"
                aria-label="Add connected sticky"
                onClick={() => controller.connectNext("right")}
              >
                <Icon name="arrow" />
                <span>Next step</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {navigation ? (
        <aside
          className={"canvas-navigator " + navigation}
          aria-label={
            navigation === "search"
              ? "Board search"
              : navigation === "frames"
                ? "Frame navigation"
                : "Board overview"
          }
          onKeyDown={event => {
            if (event.key === "Escape") {
              event.preventDefault(); event.stopPropagation(); setNavigation(null); focusCanvas(host);
            }
          }}
        >
          <header>
            <strong>
              {navigation === "search"
                ? "Find on board"
                : navigation === "frames"
                  ? "Frames"
                  : "Overview"}
            </strong>
            <button
              className="canvas-icon-button small"
              type="button"
              aria-label="Close navigation"
              onClick={() => setNavigation(null)}
            >
              <Icon name="close" />
            </button>
          </header>
          {navigation === "search" ? (
            <>
              <input
                autoFocus
                aria-label="Search board text"
                placeholder="Search notes, shapes, text…"
                value={query}
                onChange={(event) => { setQuery(event.target.value); setActiveSearchId(""); }}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing) return;
                  if (["Enter", "ArrowDown", "ArrowUp"].includes(event.key)) {
                    event.preventDefault(); event.stopPropagation();
                    stepSearch(event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1);
                  }
                }}
              />
              {query.trim() ? (
                <p className="navigator-meta" aria-live="polite">
                  {activeSearchIndex >= 0 ? `${activeSearchIndex + 1} of ` : ""}
                  {matches.length} {matches.length === 1 ? "result" : "results"}
                </p>
              ) : (
                <p className="navigator-empty">
                  Find an idea, even on a large board.
                </p>
              )}
              <div className="navigator-list">
                {visibleMatches.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-current={activeSearchId === item.id ? "true" : undefined}
                    onClick={() => { selectSearchResult(item.id); focusCanvas(host); }}
                  >
                    <span
                      className="result-swatch"
                      style={{ background: item.color }}
                    />
                    <span>
                      <small>{item.kind}</small>
                      <strong>{item.text.slice(0, 100)}</strong>
                    </span>
                  </button>
                ))}
              </div>
              {matches.length > searchPageSize && (
                <nav className="search-pages" aria-label="Search result pages">
                  <button type="button" aria-label="Previous search results" disabled={searchPageStart === 0}
                    onClick={() => selectSearchResult(matches[searchPageStart - searchPageSize].id)}>
                    Previous
                  </button>
                  <span>{searchPageStart + 1}–{searchPageStart + visibleMatches.length} of {matches.length}</span>
                  <button type="button" aria-label="Next search results" disabled={searchPageStart + searchPageSize >= matches.length}
                    onClick={() => selectSearchResult(matches[searchPageStart + searchPageSize].id)}>
                    Next
                  </button>
                </nav>
              )}
              {matches.length > 0 && <p className="navigator-meta">Enter for next · Shift+Enter for previous · Esc to return</p>}
            </>
          ) : navigation === "frames" ? (
            <>
              {frames.length ? (
                <div className="navigator-list">
                  {frames.map((frame, index) => (
                    <button
                      type="button"
                      key={frame.id}
                      onClick={() => controller.select(frame.id)}
                    >
                      <span className="frame-number">{index + 1}</span>
                      <strong>{frame.text || "Untitled frame"}</strong>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="navigator-empty">
                  Add frames with F to organize your board into areas.
                </p>
              )}
            </>
          ) : (
            <BoardOverview state={state} controller={controller} />
          )}
        </aside>
      ) : null}
      <div className="canvas-bottom-right">
        <button
          className="canvas-icon-button overview-button"
          type="button"
          aria-label="Board overview"
          aria-pressed={navigation === "map"}
          data-tip="Board overview"
          onClick={() => setNavigation(navigation === "map" ? null : "map")}
        >
          <Icon name="map" />
        </button>
        <div className="canvas-zoom">
          <button
            className="canvas-icon-button"
            type="button"
            aria-label="Zoom out"
            data-tip={`Zoom out · ${MOD}−`}
            onClick={() => controller.zoomStep(-1)}
          >
            <Icon name="minus" />
          </button>
          <button
            className="zoom-value"
            type="button"
            ref={zoomTriggerRef}
            aria-label="Zoom options"
            aria-expanded={zoomMenu}
            data-tip="Zoom options"
            onClick={() => setZoomMenu(!zoomMenu)}
          >
            {zoomLabel(state.zoom)}
          </button>
          <button
            className="canvas-icon-button"
            type="button"
            aria-label="Zoom in"
            data-tip={`Zoom in · ${MOD}+`}
            onClick={() => controller.zoomStep(1)}
          >
            <Icon name="plus" />
          </button>
          <span />
          <button
            className="canvas-icon-button"
            type="button"
            aria-label="Fit board"
            data-tip={`Fit board · ${SHIFT}1`}
            onClick={() => controller.fit()}
          >
            <Icon name="fit" />
          </button>
        </div>
        <button
          className="canvas-icon-button help-button"
          type="button"
          aria-label="Keyboard shortcuts"
          data-tip="Keyboard shortcuts · ?"
          onClick={() => setModal("help")}
        >
          <Icon name="help" />
        </button>
        {zoomMenu ? (
          <div ref={zoomPanelRef} className="zoom-menu" role="group" aria-label="Zoom options">
            <button
              type="button"
              data-shortcut={`${SHIFT}1`}
              onClick={() => {
                controller.fit();
                setZoomMenu(false);
              }}
            >
              Fit board
            </button>
            <button
              type="button"
              data-shortcut={state.selection.length ? `${SHIFT}2` : undefined}
              data-note={state.selection.length ? undefined : "Select objects first"}
              disabled={!state.selection.length}
              onClick={() => {
                controller.fit(state.selection.map((i) => i.id));
                setZoomMenu(false);
              }}
            >
              Fit selection
            </button>
            <button
              type="button"
              data-shortcut={`${SHIFT}0`}
              onClick={() => {
                controller.zoom(1);
                setZoomMenu(false);
              }}
            >
              Zoom to 100%
            </button>
            <div className="zoom-presets" role="group" aria-label="Zoom presets">
              {ZOOM_PRESETS.map(level => <button key={level} type="button"
                aria-pressed={isZoomAt(state.zoom, level)}
                onClick={() => { controller.zoom(level); setZoomMenu(false); zoomTriggerRef.current?.focus(); }}>
                {zoomLabel(level)}
              </button>)}
            </div>
          </div>
        ) : null}
      </div>
      {!state.items.length &&
      editable &&
      (state.tool === "select" || state.tool === "hand") ? (
        <div className="canvas-empty">
          <span className="empty-note-mark">
            <Icon name="sticky" />
          </span>
          <h2>Start with one idea</h2>
          <p>Add a sticky note, sketch a flow, or start from a template.</p>
          <div>
            <button
              type="button"
              className="canvas-primary"
              onClick={() => {
                // Create it right where the invitation was and start writing,
                // so typing goes into the note rather than tool shortcuts.
                const mark = chromeRef.current?.querySelector(".empty-note-mark")?.getBoundingClientRect();
                const origin = host.getBoundingClientRect();
                const y = mark ? mark.top - origin.top + mark.height / 2 : host.clientHeight * 0.42;
                controller.placeTool("sticky", host.clientWidth / 2, Math.max(140, y + 48), optionsRef.current);
              }}
            >
              <Icon name="plus" />
              Add a sticky note
            </button>
            <button type="button" onClick={() => setModal("templates")}>
              Browse templates
            </button>
          </div>
          <small>Or press N, then click · Scroll or right-drag to move around</small>
        </div>
      ) : null}
      <div className="canvas-mode-hint" aria-live="polite">{modeHint}</div>
      {contextMenu ? (
        <CanvasContextMenu
          key={contextMenu.key}
          point={contextMenu}
          label={contextMenu.selection.length ? "Selection actions" : "Board actions"}
          sections={contextMenuSections({
            selection: contextMenu.selection,
            editable,
            canComment,
            grid,
            mod: MOD,
            shift: SHIFT,
            clipboardEmpty: contextMenu.clipboardEmpty,
          })}
          onAction={(action) => {
            const selection = contextMenu.selection;
            setContextMenu(null);
            runContextAction(action, selection);
          }}
          onClose={() => setContextMenu(null)}
          onEscape={() => { focusCanvas(host); return true; }}
        />
      ) : null}
      {modal === "actions" ? <QuickActions actions={quickActions} onClose={() => setModal(null)} onRun={runQuickAction} /> : null}
      {modal === "bulk" ? (
        <Modal title="Add multiple sticky notes" onClose={() => setModal(null)}>
          <p className="modal-description">
            One idea per line. You can move and edit each note on the board.
          </p>
          <textarea
            autoFocus
            aria-label="Sticky note ideas"
            placeholder={
              "What should we explore?\nWhat is holding us back?\nWhat could we try next?"
            }
            value={bulk}
            onChange={(event) => setBulk(event.target.value)}
            maxLength={30_000}
          />
          <div className="bulk-footer">
            <Palette
              color={options.color}
              onChange={(color) =>
                setOptions((current) => ({ ...current, color }))
              }
            />
            <span>
              {lines.length} notes
              {bulk.split("\n").filter((l) => l.trim()).length > 100
                ? " · first 100 will be added"
                : ""}
            </span>
          </div>
          <footer>
            <button type="button" onClick={() => setModal(null)}>
              Cancel
            </button>
            <button
              className="canvas-primary"
              type="button"
              disabled={!lines.length}
              onClick={() => {
                controller.addNotes(lines, options.color);
                setBulk("");
                setModal(null);
              }}
            >
              Add {lines.length || ""} notes
            </button>
          </footer>
        </Modal>
      ) : null}
      {modal === "templates" ? (
        <Modal title="Templates" onClose={() => setModal(null)} wide>
          <div className="patterns-intro"><p className="modal-description">
            Start from a board that is already laid out, then change anything
            you like. Every note, shape and arrow stays editable.
          </p><img src="/brand/patterns.webp" alt="" width="1254" height="1254" /></div>
          <div className="canvas-template-grid">
            {DEMO_PATTERNS.map(pattern => (
              <button type="button" key={pattern.id} className="canvas-template-card"
                onClick={() => { controller.insertTemplate(pattern.id); setModal(null); }}>
                <div className="template-preview demo-pattern-preview"><PatternPreview pattern={pattern} /></div>
                <strong>{pattern.title}</strong>
                <p>{pattern.description}</p>
                <span>{pattern.id === "update-flow" ? "Explore the demo" : "Use template"} <Icon name="arrow" /></span>
              </button>
            ))}
            {templateCards.map((template) => (
              <button
                type="button"
                key={template.id}
                className="canvas-template-card"
                onClick={() => {
                  controller.insertTemplate(template.id);
                  setModal(null);
                }}
              >
                <div className={"template-preview " + template.id}>
                  {template.columns.map((column, index) => (
                    <div key={column}>
                      <small>{column}</small>
                      {(template.id === "flow" ? [0] : [0, 1, 2]).map((row) => (
                        <i
                          key={row}
                          style={{ background: STICKY_COLORS[index].value }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
                <strong>{template.title}</strong>
                <p>{template.description}</p>
                <span>
                  Use template <Icon name="arrow" />
                </span>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}
      {modal === "help" ? (
        <Modal title="Keyboard shortcuts" onClose={() => setModal(null)} wide>
          <button type="button" className="canvas-primary help-tour" onClick={()=>{setModal(null);openTour();}}>Take a quick board tour</button>
          <p className="modal-description">
            Less reaching for tools. More time for your ideas.
          </p>
          {SHORTCUT_SECTIONS.map((section) => (
            <section key={section.title} className="shortcut-section" aria-label={section.title}>
              <h3>{section.title}</h3>
              <div className="shortcut-list">
                {section.title === "Tools" ? TOOLS.map((tool) => (
                  <div key={tool.id}>
                    <span>
                      <Icon name={tool.id} />
                      {tool.label}
                    </span>
                    <kbd>{tool.key}</kbd>
                  </div>
                )) : null}
                {section.items.map(([label, key, icon]) => (
                  <div key={label}>
                    <span>{icon ? <Icon name={icon} /> : null}{label}</span>
                    <kbd>{key}</kbd>
                  </div>
                ))}
              </div>
            </section>
          ))}
          <p className="shortcut-note">
            {IS_MAC ? "Use Ctrl instead of ⌘ on Windows and Linux. " : ""}Double-click an
            object to edit its text. Right-click anything for its actions.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
function BoardOverview({
  state,
  controller,
}: {
  state: CanvasState;
  controller: CanvasController;
}) {
  if (!state.items.length)
    return (
      <p className="navigator-empty">Your board overview will appear here.</p>
    );
  const boxes = state.items.filter((item) => item.kind !== "connector");
  if (!boxes.length)
    return (
      <p className="navigator-empty">Add objects to see the board overview.</p>
    );
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  const width = Math.max(...boxes.map((b) => b.x + b.w)) - x || 1;
  const height = Math.max(...boxes.map((b) => b.y + b.h)) - y || 1;
  return (
    <>
      <svg
        className="board-minimap"
        viewBox={[x - 20, y - 20, width + 40, height + 40].join(" ")}
        role="group"
        aria-label="Objects on board"
      >
        {boxes.slice(0, 500).map((item) => (
          <g
            key={item.id}
            role="button"
            tabIndex={0}
            aria-label={item.text || item.kind}
            onClick={() => controller.select(item.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                controller.select(item.id);
              }
            }}
          >
            <rect
              x={item.x}
              y={item.y}
              width={item.w}
              height={item.h}
              rx={3}
              fill={item.kind === "frame" ? "none" : item.color}
              stroke={item.kind === "frame" ? "#b8c2d3" : "#7f8ca4"}
              strokeWidth={Math.max(1, width / 400)}
            />
          </g>
        ))}
      </svg>
      <button
        className="overview-fit"
        type="button"
        onClick={() => controller.fit()}
      >
        Show the whole board
      </button>
    </>
  );
}

function StickyTextEditor({
  state,
  controller,
  host,
  onEditor,
  onToggleMark,
  fittedSize,
  dark,
}: {
  dark: boolean;
  state: CanvasState;
  controller: CanvasController;
  host: HTMLElement;
  onEditor: (editor: StickyInlineEditor | null) => void;
  onToggleMark: (mark: TextMark) => void;
  fittedSize?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inlineRef = useRef<StickyInlineEditor | null>(null);
  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;
  const editing = state.editing!;
  const bounds = controller.viewBounds(editing.id);
  const yText = controller.editingText()?.yText ?? null;
  const autoSize = useRef(false);
  autoSize.current = editing.textStyle.size === "auto";
  const minimumSize = useRef(12);
  minimumSize.current = 12 * state.zoom * editing.textScale;
  useEffect(() => {
    const root = ref.current;
    const paper = root?.parentElement;
    if (!root || !paper) return;
    // The canvas measures auto-sized text a frame after it changes. While
    // typing fast, shrink the overlay before the browser paints so the new
    // line never shows clipped at the old, larger size.
    const shrinkToFit = () => {
      if (!autoSize.current) return;
      const padding = parseFloat(getComputedStyle(paper).paddingTop) || 0;
      const available = paper.clientHeight - padding * 2;
      let size = parseFloat(paper.style.fontSize) || 0;
      const step = Math.max(0.5, minimumSize.current / 12);
      while (size - step >= minimumSize.current && root.scrollHeight > available + 1) {
        size -= step;
        paper.style.fontSize = `${size}px`;
      }
      // At the smallest size the note grows instead; show the new line at
      // once rather than a frame later, when the canvas has grown the paper.
      if (root.scrollHeight > available + 1) paper.style.height = `${root.scrollHeight + padding * 2}px`;
    };
    const observer = new MutationObserver(shrinkToFit);
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [yText]);
  useEffect(() => {
    const root = ref.current;
    if (!root || !yText) return;
    // The rich editor writes straight to the note's shared text, so edits
    // from collaborators and undo land in place without a draft to merge.
    const inline = createStickyInlineEditor(yText);
    inline.mount(root);
    inlineRef.current = inline;
    root.focus({ preventScroll: true });
    inline.focusEnd();
    onEditorRef.current(inline);
    host.classList.add("sticky-text-editing");
    return () => {
      host.classList.remove("sticky-text-editing");
      onEditorRef.current(null);
      inlineRef.current = null;
      inline.unmount();
    };
  }, [host, yText]);
  if (!bounds) return null;
  const style = editing.textStyle;
  const scale = state.zoom * editing.textScale;
  return (
    <div
      className="sticky-text-editor"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.w,
        height: bounds.h,
        background: dark ? editing.colorDark : editing.color,
        fontSize: (fittedSize ?? stickySizePx(style.size)) * scale,
        fontFamily: stickyFontCss(style.font) ?? "Arial, Helvetica, sans-serif",
        textAlign: style.align,
        padding: 24 * scale,
        lineHeight: 1.4,
      }}
      onMouseDown={(event) => {
        // Paper around the text is a focus target, never a second editable
        // region where the browser could insert text outside the shared model.
        if (event.target === event.currentTarget) {
          event.preventDefault();
          ref.current?.focus({ preventScroll: true });
          inlineRef.current?.focusEnd();
        }
      }}
      onBlur={(event) => {
        // Toolbar menus take focus without ending the edit.
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        if (next instanceof Element && next.closest(".sticky-selection-actions")) return;
        controller.finishEditing(editing.id);
      }}
      onPaste={(event) => {
        event.preventDefault();
        const inline = inlineRef.current;
        const range = inline?.getInlineRange();
        if (!inline || !range) return;
        const text = pastedStickyText(
          event.clipboardData.getData("text/plain"),
          inline.yTextLength,
          range.length,
        );
        inline.insertText(range, text);
        inline.setInlineRange({ index: range.index + text.length, length: 0 });
      }}
      onDrop={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        const mark = markForShortcut(event);
        if (mark) {
          event.preventDefault();
          event.stopPropagation();
          onToggleMark(mark);
        } else if (
          event.key.toLowerCase() === "z" &&
          (event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) controller.redo();
          else controller.undo();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault(); event.stopPropagation(); if (!event.repeat) controller.addAdjacentNote();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          controller.finishEditing();
          focusCanvas(host);
        } else if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) controller.addAdjacentNote();
        }
      }}
    >
      <div ref={ref} className="sticky-text-input" role="textbox" aria-multiline="true" aria-label="Edit sticky note" spellCheck />
    </div>
  );
}
