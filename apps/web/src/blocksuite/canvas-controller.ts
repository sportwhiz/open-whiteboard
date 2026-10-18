import * as Y from "yjs";
import { demoPattern, type DemoPatternId } from "./demo-patterns";
import { nativeBlockText } from "./native-block-text";
import { canvasFitPadding, fitCanvas, revealDelta, unionBounds } from "./canvas-layout";
import { STICKY_PALETTE, resolveStickyPaper, stickyPaper } from "./sticky-palette";
import { steppedZoom } from "./canvas-zoom";
import { layerOrder } from "./layer-order";
import { createNoteCommitTracker } from "./note-commit";
import { startsNewStep } from "./history-merge";
import {
  DefaultTool,
  EdgelessCRUDIdentifier,
} from "@blocksuite/affine/blocks/surface";
import { BrushTool, EraserTool } from "@blocksuite/affine/gfx/brush";
import { ConnectorTool, mountConnectorLabelEditor } from "@blocksuite/affine/gfx/connector";
import { PanTool } from "@blocksuite/affine/gfx/pointer";
import { ShapeTool, mountShapeTextEditor } from "@blocksuite/affine/gfx/shape";
import { TextTool, mountTextElementEditor } from "@blocksuite/affine/gfx/text";
import { mountGroupTitleEditor } from "@blocksuite/affine/gfx/group";
import { mountFrameTitleEditor } from "@blocksuite/affine/widgets/frame-title";
import { frameFitBounds } from "./element-toolbar";
import { createGroupFromSelectedCommand, ungroupCommand } from "@blocksuite/affine/gfx/group";
import { FrameTool } from "@blocksuite/affine/blocks/frame";
import { addImages } from "@blocksuite/affine/blocks/image";
import {
  duplicate,
  type EdgelessRootBlockComponent,
} from "@blocksuite/affine/blocks/root";
import { Bound } from "@blocksuite/affine/global/gfx";
import {
  ConnectorMode,
  PointStyle,
  NoteDisplayMode,
  StrokeStyle,
  ShapeStyle,
  ShapeType,
  ConnectorElementModel,
  ShapeElementModel,
  TextElementModel,
  GroupElementModel,
  getShapeType,
  type ShapeName,
} from "@blocksuite/affine/model";
import { EditPropsStore } from "@blocksuite/affine/shared/services";
import { Text } from "@blocksuite/affine/store";
import {
  BaseTool,
  GfxControllerIdentifier,
  isGfxGroupCompatibleModel,
  type GfxModel,
} from "@blocksuite/std/gfx";
import type { PointerEventState } from "@blocksuite/affine/std";
import type { WhiteboardEditorElement } from "./editor-container";
import {
  arrangeBoxes,
  findOpenPosition,
  connectedPosition,
  canArrange,
  readingOrder,
  facingPorts,
  nextNotePlacement,
  duplicatePlacement,
  CONNECTION_PORTS,
  type Direction,
  type Arrangement,
} from "./layout";
import {
  readStickyTextStyle,
  storedStickyTextStyle,
  STICKY_TEXT_STYLE_KEY,
  type StickyTextStyle,
} from "./sticky-text-style";
import { canvasPointAt, topmostObject } from "./canvas-hit-test";
export { topmostObject };

export type CanvasTool =
  | "select"
  | "hand"
  | "sticky"
  | "text"
  | "shape"
  | "connector"
  | "pen"
  | "eraser"
  | "frame";
/** Swatches offered in the UI; values are each family's light paper. */
export const STICKY_COLORS = STICKY_PALETTE.map((family) => ({ name: family.name, value: family.light }));
export type CanvasOptions = {
  color: string;
  shape: ShapeName;
  line: ConnectorMode;
  penColor: string;
  penWidth: 2 | 4 | 6 | 12;
};
export const DEFAULT_OPTIONS: CanvasOptions = {
  color: STICKY_COLORS[0].value,
  shape: "roundedRect",
  line: ConnectorMode.Orthogonal,
  penColor: "#27334b",
  penWidth: 4,
};

// Native blocks remain the source of truth for persistence, history and MCP.
export function createSticky(
  editor: WhiteboardEditorElement,
  x: number,
  y: number,
  color: string,
  content = "",
  size = { w: 208, h: 208 },
  appearance?: { background?: unknown; edgeless?: Record<string, unknown> },
) {
  const gfx = editor.std.get(GfxControllerIdentifier);
  const store = editor.doc;
  const id = store.addBlock(
    "affine:note",
    {
      xywh: new Bound(x, y, size.w, size.h).serialize(),
      index: gfx.layer.generateIndex(),
      displayMode: NoteDisplayMode.EdgelessOnly,
      background: appearance?.background ?? stickyPaper(color),
      edgeless: {
        collapse: true,
        scale: 1,
        style: {
          borderRadius: 2,
          borderSize: 0,
          borderStyle: StrokeStyle.None,
          shadowType: "--affine-note-shadow-box",
        },
        ...appearance?.edgeless,
        [STICKY_TEXT_STYLE_KEY]: appearance ? storedStickyTextStyle(readStickyTextStyle(appearance.edgeless)) : { size: "auto" },
        collapsedHeight: size.h / (Number(appearance?.edgeless?.scale) || 1),
      },
    },
    store.root!.id,
  );
  const paragraphId = store.addBlock(
    "affine:paragraph",
    { type: "text", text: new Text(content) },
    id,
  );
  return { id, paragraphId };
}

/** One default size per shape type, however the shape is created. */
export const SHAPE_SIZE: Record<string, { w: number; h: number }> = {
  rect: { w: 200, h: 128 },
  roundedRect: { w: 200, h: 128 },
  ellipse: { w: 180, h: 128 },
  diamond: { w: 180, h: 140 },
  triangle: { w: 170, h: 140 },
};

/** Create the native preview only after the pointer enters usable canvas. */
export class CanvasShapeTool extends ShapeTool {
  static override toolName = "whiteboard:shape";
  private awaitingPointer = true;
  override activate() { this.clearOverlay(); this.awaitingPointer = true; }
  override pointerMove(event: PointerEventState) {
    const host = this.std.host.closest<HTMLElement>(".editor-canvas");
    if (!host || !canvasPointAt(host, { x: event.raw.clientX, y: event.raw.clientY })) {
      this.clearOverlay(); this.awaitingPointer = true; return;
    }
    if (this.awaitingPointer) { this.createOverlay(); this.awaitingPointer = false; }
    super.pointerMove(event);
  }
  override pointerOut() { this.clearOverlay(); this.awaitingPointer = true; }
  // Like a new note, a new shape opens ready for its label, so drawing and
  // typing stays one motion; Escape keeps it selected.
  override click(event: PointerEventState) {
    super.click(event);
    // Clicked shapes are centred on the pointer at the shared default size,
    // like notes (the engine anchored a smaller shape's corner there).
    const [shape] = this.gfx.selection.selectedElements;
    if (shape instanceof ShapeElementModel && this.gfx.selection.selectedElements.length === 1) {
      const name = (this.activatedOption as { shapeName?: string }).shapeName ?? "rect";
      const size = SHAPE_SIZE[name] ?? SHAPE_SIZE.rect;
      const [x, y] = this.gfx.viewport.toModelCoord(event.x, event.y);
      this.std.store.transact(() => { shape.xywh = new Bound(x - size.w / 2, y - size.h / 2, size.w, size.h).serialize(); });
    }
    this.editCreated();
  }
  override dragEnd() { super.dragEnd(); this.editCreated(); }
  private editCreated() {
    const [shape] = this.gfx.selection.selectedElements;
    const root = this.std.view.getBlock(this.std.store.root!.id);
    if (this.gfx.selection.selectedElements.length !== 1 || !(shape instanceof ShapeElementModel) || !root || this.std.store.readonly) return;
    mountShapeTextEditor(shape, root);
  }
}

/** The engine binds a connector dragged from the middle of one object to
 * the middle of another to their first anchors (top to top), which routes
 * an elbow over both. Ends dropped inside an object, away from any anchor,
 * bind to the sides that face the other end instead. */
export class CanvasConnectorTool extends ConnectorTool {
  static override toolName = "whiteboard:connector";
  private lastPoint: [number, number] | null = null;
  override dragMove(event: PointerEventState) {
    this.lastPoint = [event.x, event.y];
    super.dragMove(event);
  }
  override dragEnd() {
    const internals = this as unknown as { _connector: ConnectorElementModel | null; _startPoint: [number, number] | null };
    const connector = internals._connector;
    const start = internals._startPoint;
    const end = this.lastPoint ? this.gfx.viewport.toModelCoord(...this.lastPoint) : null;
    super.dragEnd();
    this.lastPoint = null;
    if (!connector || !start || !end || !connector.source?.id || !connector.target?.id) return;
    const sourceModel = this.gfx.getElementById<GfxModel>(connector.source.id);
    const targetModel = this.gfx.getElementById<GfxModel>(connector.target.id);
    if (!sourceModel || !targetModel) return;
    const zoom = this.gfx.viewport.zoom;
    // Aimed: the pointer was within a few pixels of the bound point, and
    // nearer it than the middle (on a small, zoomed-out object every edge
    // point is within a few pixels of the middle).
    const aimed = (point: [number, number], model: GfxModel, position?: [number, number]) => {
      if (!position) return false;
      const bound = model.elementBound;
      const anchor = [bound.x + bound.w * position[0], bound.y + bound.h * position[1]];
      const toAnchor = Math.hypot(anchor[0] - point[0], anchor[1] - point[1]);
      const toMiddle = Math.hypot(bound.x + bound.w / 2 - point[0], bound.y + bound.h / 2 - point[1]);
      return toAnchor * zoom <= 14 && toAnchor < toMiddle;
    };
    const ports = facingPorts(sourceModel.elementBound, targetModel.elementBound);
    const source = aimed(start, sourceModel, connector.source.position) ? connector.source.position : ports.source;
    const target = aimed(end, targetModel, connector.target.position) ? connector.target.position : ports.target;
    this.gfx.updateElement(connector, {
      source: { id: connector.source.id, position: source },
      target: { id: connector.target.id, position: target },
    });
  }
}

export class StickyTool extends BaseTool<{ color: string }> {
  static override toolName = "whiteboard:sticky";
  private dragging = false;
  private preview(event: PointerEventState | null) {
    this.std.host.closest("whiteboard-editor")?.dispatchEvent(
      new CustomEvent("whiteboard-sticky-preview", {
        bubbles: true,
        detail: event
          ? { x: event.x, y: event.y, color: this.activatedOption.color }
          : null,
      }),
    );
  }
  override pointerMove(event: PointerEventState) {
    this.preview(event);
  }
  override pointerOut() {
    if (!this.dragging) this.preview(null);
  }
  override dragStart(event: PointerEventState) {
    this.dragging = true;
    this.preview(event);
  }
  override dragMove(event: PointerEventState) {
    this.preview(event);
  }
  override dragEnd(event: PointerEventState) {
    if (!this.dragging) return;
    this.dragging = false;
    const host = this.std.host.closest<HTMLElement>(".editor-canvas");
    if (
      !host ||
      !canvasPointAt(host, { x: event.raw.clientX, y: event.raw.clientY })
    ) {
      this.preview(null);
      return;
    }
    this.click(event);
  }
  override activate() {
    this.dragging = false;
    this.gfx.cursor$.value = "crosshair";
  }
  override deactivate() {
    this.dragging = false;
    this.preview(null);
    this.gfx.cursor$.value = "default";
  }
  override click(event: PointerEventState) {
    if (this.doc.readonly) return;
    const [x, y] = this.gfx.viewport.toModelCoord(event.x, event.y);
    this.doc.captureSync();
    const editor = this.gfx.std.host.closest(
      "whiteboard-editor",
    ) as WhiteboardEditorElement;
    const note = createSticky(
      editor,
      x - 104,
      y - 104,
      this.activatedOption.color,
    );
    this.doc.captureSync();
    this.gfx.tool.setTool(DefaultTool);
    this.gfx.selection.set({ elements: [note.id] });
    editor.dispatchEvent(
      new CustomEvent("whiteboard-edit-note", {
        bubbles: true,
        detail: { id: note.id },
      }),
    );
  }
}

const isFrame = (model: unknown) =>
  Boolean(model && typeof model === "object" && "flavour" in model &&
    (model as { flavour: string }).flavour === "affine:frame");
/** Member of a real group or mind map (frames only contain their children). */
const isGrouped = (model: GfxModel) => Boolean(model.group) && !isFrame(model.group);

export type CanvasItem = {
  id: string;
  kind: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  locked: boolean;
  /** Paper used in dark mode (equals color for custom colors). */
  colorDark: string;
  /** Whether every character of the note's text has each style. */
  marks: Record<TextMark, boolean>;
  /** The text color shared by all of the note's text, or null. */
  textColor: string | null;
  textStyle: StickyTextStyle;
  textScale: number;
  simpleSticky: boolean;
  arrangeable: boolean;
};
export const TEXT_MARKS = ["bold", "italic", "underline", "strike"] as const;
export type TextMark = (typeof TEXT_MARKS)[number];
export type CanvasState = {
  tool: CanvasTool;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  selection: CanvasItem[];
  items: CanvasItem[];
  editing: CanvasItem | null;
};

export function createCanvasController(editor: WhiteboardEditorElement) {
  const gfx = editor.std.get(GfxControllerIdentifier);
  const store = editor.doc;
  const crud = editor.std.get(EdgelessCRUDIdentifier);
  const canvasHost = editor.closest<HTMLElement>(".editor-canvas") ?? editor;
  const editable = () =>
    editor.isConnected &&
    !store.readonly &&
    !editor.closest<HTMLElement>(".editor-canvas")?.inert;
  let editing: { id: string } | null = null;
  // The first time this person finishes writing a note they created in
  // this session, the app may offer to keep it private (brainstorms).
  const commits = createNoteCommitTracker();
  store.slots.blockUpdated.subscribe((event) => {
    if (event.type === "add" && event.flavour === "affine:note") commits.added(event.id, event.isLocal, event.init);
  });
  const reportCommitted = (id: string) => {
    // Restarting the same edit (or moving straight into it) is not an end.
    if (editing?.id === id || !editor.isConnected) return;
    const model = gfx.getElementById<GfxModel>(id);
    const note = model && item(model);
    if (!note || note.kind !== "note" || !note.simpleSticky) return;
    if (commits.ended(id, note.text)) {
      const read = () => {
        const current = gfx.getElementById<GfxModel>(id);
        const value = current && item(current);
        return value?.kind === "note" && value.simpleSticky ? value.text : null;
      };
      window.dispatchEvent(new CustomEvent("whiteboard-note-committed", { detail: { id, text: note.text, read } }));
    }
  };
  const clearEditing = () => {
    const ended = editing?.id;
    editing = null;
    if (ended) queueMicrotask(() => reportCommitted(ended));
  };
  let cachedItems: CanvasItem[] | null = null;
  /** History work still in flight (a duplicate's clone). */
  let pendingHistoryWork: Promise<unknown> | null = null;
  let lastNudge: { at: number; key: string } | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const item = (model: GfxModel): CanvasItem => {
    const props =
      "props" in model
        ? (model.props as Record<string, unknown>)
        : (model as unknown as Record<string, unknown>);
    const kind =
      "flavour" in model
        ? model.flavour.replace("affine:", "")
        : String(props.type ?? "");
    const textValue =
      kind === "note" && "children" in model
        ? nativeBlockText(model)
        : String(props.text ?? props.title ?? "");
    const bound = model.elementBound;
    const deltas =
      kind === "note" && "children" in model && textValue.length
        ? model.children.flatMap(
            (child) => (child.props as { text?: Text }).text?.toDelta() ?? [],
          )
        : [];
    const every = (test: (attributes: Record<string, unknown>) => boolean) =>
      deltas.length > 0 &&
      deltas.every((part) => test((part.attributes ?? {}) as Record<string, unknown>));
    const firstColor = deltas[0]?.attributes?.color;
    const color = props.background ?? props.fillColor;
    // Note paper renders through the palette (see create-editor); other
    // objects keep their stored colours exactly.
    const paper = kind === "note" ? resolveStickyPaper(color) : undefined;
    const bg =
      paper?.light ?? (color && typeof color === "object"
        ? (color as { light?: string }).light
        : color);
    const bgDark = paper?.dark ?? (color && typeof color === "object"
      ? (color as { dark?: string }).dark
      : color);
    const locked = model.isLocked();
    return {
      id: model.id,
      kind,
      text: textValue,
      x: bound.x,
      y: bound.y,
      w: bound.w,
      h: bound.h,
      color: typeof bg === "string" && bg.startsWith("#") ? bg : "#e5eaf4",
      colorDark: typeof bgDark === "string" && bgDark.startsWith("#") ? bgDark
        : typeof bg === "string" && bg.startsWith("#") ? bg : "#e5eaf4",
      locked: Boolean(props.lockedBySelf ?? props.locked),
      // Frames contain objects without grouping them: their children can be
      // arranged and stay in the frame. Real groups move as one object.
      arrangeable: canArrange({ kind, locked, inGroup: isGrouped(model) }),
      marks: Object.fromEntries(
        TEXT_MARKS.map((mark) => [mark, every((attributes) => Boolean(attributes[mark]))]),
      ) as Record<TextMark, boolean>,
      textColor:
        typeof firstColor === "string" &&
        every((attributes) => attributes.color === firstColor)
          ? firstColor
          : null,
      textStyle: readStickyTextStyle(props.edgeless),
      textScale: Math.max(0.01, Number((props.edgeless as { scale?: number } | undefined)?.scale) || 1),
      simpleSticky:
        kind === "note" &&
        "children" in model &&
        model.children.length <= 1 &&
        model.children.every((child) => child.flavour === "affine:paragraph") &&
        textValue.length <= 10_000,
    };
  };
  const toolNames: Record<string, CanvasTool> = {
    default: "select",
    pan: "hand",
    "whiteboard:sticky": "sticky",
    "affine:note": "sticky",
    text: "text",
    shape: "shape",
    "whiteboard:shape": "shape",
    connector: "connector",
    "whiteboard:connector": "connector",
    brush: "pen",
    eraser: "eraser",
    frame: "frame",
  };
  const fit = (ids?: string[]) => {
    editor.dispatchEvent(new Event("whiteboard-manual-navigation"));
    const models = (ids ?? gfx.gfxElements.map((model) => model.id))
      .map((id) => gfx.getElementById<GfxModel>(id))
      .filter((model): model is GfxModel => Boolean(model));
    fitCanvas(canvasHost, gfx.viewport, unionBounds(models.map((m) => m.elementBound)), true);
  };
  const reveal = (id: string) => {
    const model = gfx.getElementById<GfxModel>(id);
    if (!model) return;
    const bound = model.elementBound;
    const [x, y] = gfx.viewport.toViewCoord(bound.x, bound.y);
    const delta = revealDelta({ x, y, w: bound.w * gfx.viewport.zoom, h: bound.h * gfx.viewport.zoom },
      canvasHost.clientWidth, canvasHost.clientHeight, canvasFitPadding(canvasHost));
    // A one-frame transition also cancels an older fit/search animation.
    gfx.viewport.smoothTranslate(gfx.viewport.centerX + delta.x / gfx.viewport.zoom,
      gfx.viewport.centerY + delta.y / gfx.viewport.zoom, 1);
  };
  const selectTool = (tool: CanvasTool, options: CanvasOptions) => {
    clearEditing();
    if (!editable() && tool !== "select" && tool !== "hand") return;
    switch (tool) {
      case "select":
        gfx.tool.setTool(DefaultTool);
        break;
      case "hand":
        gfx.tool.setTool(PanTool, { panning: true });
        break;
      case "sticky":
        gfx.tool.setTool(StickyTool, { color: options.color });
        break;
      case "text":
        editor.std.get(EditPropsStore).recordLastProps("text", {
          color: { light: "#23304a", dark: "#eef2fb" },
        });
        gfx.tool.setTool(TextTool);
        break;
      case "shape":
        editor.std
          .get(EditPropsStore)
          .recordLastProps(("shape:" + options.shape) as "shape:rect", {
            fillColor: { light: "#ffffff", dark: "#283347" },
            color: { light: "#23304a", dark: "#eef2fb" },
            strokeColor: { light: "#425574", dark: "#b9c5dc" },
            strokeWidth: 2,
            shapeStyle: ShapeStyle.General,
            filled: true,
          });
        gfx.tool.setTool(CanvasShapeTool, { shapeName: options.shape });
        break;
      case "connector":
        editor.std.get(EditPropsStore).recordLastProps("connector", {
          stroke: { light: "#5c6980", dark: "#aab7cf" },
        });
        gfx.tool.setTool(CanvasConnectorTool, { mode: options.line });
        break;
      case "pen":
        editor.std.get(EditPropsStore).recordLastProps("brush", {
          color:
            options.penColor === "#27334b"
              ? { light: "#27334b", dark: "#c2ccdf" }
              : options.penColor,
          lineWidth: options.penWidth,
        });
        gfx.tool.setTool(BrushTool);
        break;
      case "eraser":
        gfx.tool.setTool(EraserTool);
        break;
      case "frame":
        gfx.tool.setTool(FrameTool);
        break;
    }
  };
  const startEditing = (id: string, initial?: string) => {
    const note = gfx.getElementById<GfxModel>(id);
    if (!editable() || !note || item(note).kind !== "note" || item(note).locked)
      return false;
    if (editing?.id === id) return true;
    // Keep document notes and embedded blocks in the native rich editor. The
    // sticky editor owns only a single paragraph, so it never flattens old data.
    if (
      !("children" in note) ||
      item(note).text.length > 10_000 ||
      note.children.length > 1 ||
      note.children.some((child) => child.flavour !== "affine:paragraph")
    )
      return false;
    gfx.tool.setTool(DefaultTool);
    gfx.selection.set({ elements: [id], editing: false });
    store.captureSync();
    clearEditing();
    const paragraph =
      note.children[0] ??
      store.getModelById(
        store.addBlock(
          "affine:paragraph",
          { type: "text", text: new Text() },
          note.id,
        ),
      )!;
    editing = { id };
    if (initial !== undefined) {
      const text = (paragraph.props as { text: Text }).text;
      store.transact(() => text.insert(initial, text.length));
    }
    notify();
    return true;
  };
  /** The single paragraph's text of the note being edited, for the rich editor. */
  const editingText = () => {
    const note = editing && gfx.getElementById<GfxModel>(editing.id);
    if (!note || !("children" in note)) return null;
    return (note.children[0]?.props as { text?: Text } | undefined)?.text ?? null;
  };
  const selectedNotes = () =>
    gfx.selection.selectedElements.filter(
      (model) =>
        item(model).kind === "note" && !item(model).locked && "children" in model,
    );
  const formatNotes = (attributes: Record<string, unknown>) => {
    const notes = selectedNotes();
    if (!editable() || !notes.length) return;
    store.captureSync();
    store.transact(() =>
      notes.forEach((model) => {
        if (!("children" in model)) return;
        for (const child of model.children) {
          const text = (child.props as { text?: Text }).text;
          if (text?.length) text.format(0, text.length, attributes);
        }
      }),
    );
    store.captureSync();
  };
  const editShape = (model: GfxModel, initialText?: string) => {
    if (
      !editable() ||
      !(model instanceof ShapeElementModel) ||
      model.isLocked()
    )
      return false;
    const root = editor.std.view.getBlock(store.root!.id);
    if (!root) return false;
    store.captureSync();
    mountShapeTextEditor(model, root);
    if (initialText !== undefined && model.text) {
      store.transact(() => {
        model.text!.delete(0, model.text!.length);
        model.text!.insert(0, initialText);
      });
    }
    return true;
  };
  const editText = (id: string) => {
    const model = gfx.getElementById<GfxModel>(id);
    const root = editor.std.view.getBlock(store.root!.id);
    if (!editable() || !(model instanceof TextElementModel) || model.isLocked() || !root) return false;
    mountTextElementEditor(model, root);
    return true;
  };
  /** Move fresh duplicates beside their originals, clear of other objects
   * (the engine drops them at a fixed offset, often on top of the next note). */
  const placeCopies = (originalIds: Set<string>, originals: GfxModel[]) => {
    const copies = gfx.selection.selectedElements.filter((model) => !originalIds.has(model.id));
    const source = unionBounds(originals.map((model) => model.elementBound));
    const current = unionBounds(copies.map((model) => model.elementBound));
    if (!copies.length || !source || !current) return;
    const copyIds = new Set(copies.map((model) => model.id));
    const obstacles = connectionObstacles().filter((box) => !copyIds.has(box.id) && box.kind !== "frame");
    const { dx, dy } = duplicatePlacement(source, obstacles);
    const shiftX = source.x + dx - current.x, shiftY = source.y + dy - current.y;
    if (!shiftX && !shiftY) return;
    const moved = new Set<GfxModel>(copies);
    for (const model of copies)
      if (isGfxGroupCompatibleModel(model)) for (const child of model.descendantElements) moved.add(child as GfxModel);
    store.transact(() => {
      for (const model of moved) {
        const bound = Bound.deserialize(model.xywh);
        bound.x += shiftX;
        bound.y += shiftY;
        if (model instanceof ConnectorElementModel) model.moveTo(bound);
        else model.xywh = bound.serialize();
      }
    });
  };
  const addNotes = (texts: string[], color: string) => {
    if (!editable() || !texts.length) return;
    const columns = Math.min(4, Math.ceil(Math.sqrt(texts.length)));
    const existing = gfx.gfxElements.length ? gfx.elementsBound : null;
    const x = existing ? existing.x : gfx.viewport.center.x - columns * 120;
    const y = existing
      ? existing.y + existing.h + 96
      : gfx.viewport.center.y - 104;
    const ids: string[] = [];
    store.captureSync();
    store.transact(() => {
      texts.forEach((text, index) =>
        ids.push(
          createSticky(
            editor,
            x + (index % columns) * 240,
            y + Math.floor(index / columns) * 240,
            color,
            text,
          ).id,
        ),
      );
    });
    store.captureSync();
    gfx.tool.setTool(DefaultTool);
    gfx.selection.set({ elements: ids });
    fit(ids);
    return ids;
  };
  const connectionObstacles = () =>
    gfx.gfxElements
      .map(item)
      .filter((m) => !["frame", "connector", "group"].includes(m.kind));
  const connectionPreview = (
    sourceId: string,
    direction: Direction,
    point?: { x: number; y: number },
  ) => {
    const source = gfx.getElementById<GfxModel>(sourceId);
    if (
      !source ||
      !editable() ||
      item(source).locked ||
      !item(source).simpleSticky
    )
      return null;
    const old = item(source);
    if (point) {
      const [x, y] = gfx.viewport.toModelCoord(point.x, point.y);
      const hit = gfx.getElementByPoint(x, y);
      if (hit?.id === source.id) return null;
      if (
        hit &&
        hit.id !== source.id &&
        ["note", "shape", "text", "image"].includes(item(hit).kind)
      ) {
        return { source: old, target: item(hit), existing: true, direction };
      }
      return {
        source: old,
        target: {
          ...old,
          id: "new",
          x: x - old.w / 2,
          y: y - old.w / 2,
          h: old.w,
          text: "",
        },
        existing: false,
        direction,
      };
    }
    const position = connectedPosition(old, direction, connectionObstacles(), { w: old.w, h: old.w });
    return {
      source: old,
      target: { ...old, ...position, text: "" },
      existing: false,
      direction,
    };
  };
  const connectNext = (
    direction: Direction,
    sourceId = gfx.selection.selectedElements[0]?.id,
    point?: { x: number; y: number },
  ) => {
    if (!sourceId) return;
    const preview = connectionPreview(sourceId, direction, point);
    if (!preview) return;
    const { source, target, existing } = preview;
    const sourceModel = gfx.getElementById<GfxModel>(sourceId)!;
    const ports = CONNECTION_PORTS[direction];
    let nextId = target.id;
    store.captureSync();
    store.transact(() => {
      if (!existing) {
        const appearance = "props" in sourceModel
          ? sourceModel.props as { background?: unknown; edgeless?: Record<string, unknown> }
          : undefined;
        nextId = createSticky(editor, target.x, target.y, source.color, "", { w: target.w, h: target.h }, appearance).id;
      }
      crud.addElement("connector", {
        mode: ConnectorMode.Orthogonal,
        strokeWidth: 2,
        stroke: { light: "#5c6980", dark: "#aab7cf" },
        frontEndpointStyle: PointStyle.None,
        rearEndpointStyle: PointStyle.Arrow,
        source: { id: sourceId, position: ports.source },
        target: existing
          ? { id: nextId }
          : { id: nextId, position: ports.target },
      });
    });
    store.captureSync();
    gfx.tool.setTool(DefaultTool);
    gfx.selection.set({ elements: [nextId] });
    if (!existing) reveal(nextId);
    if (!existing) startEditing(nextId);
  };
  return {
    editable,
    connectionPreview,
    toModelPoint(x: number, y: number) {
      return gfx.viewport.toModelCoord(x, y);
    },
    toViewBox(box: { x: number; y: number; w: number; h: number }) {
      const [x, y] = gfx.viewport.toViewCoord(box.x, box.y);
      return {
        x,
        y,
        w: box.w * gfx.viewport.zoom,
        h: box.h * gfx.viewport.zoom,
      };
    },
    /** Create a note, shape or text at a view point. With findSpace (keyboard
     * placement) the object moves to the nearest free spot instead of landing
     * on top of existing content, and the view follows it. */
    placeTool(
      tool: "sticky" | "shape" | "text",
      x: number,
      y: number,
      options: CanvasOptions,
      { findSpace = false }: { findSpace?: boolean } = {},
    ) {
      if (!editable()) return;
      clearEditing();
      const [mx, my] = gfx.viewport.toModelCoord(x, y);
      const size = tool === "sticky" ? { w: 208, h: 208 } : tool === "shape" ? SHAPE_SIZE[options.shape] ?? SHAPE_SIZE.rect : { w: 32, h: 32 };
      let box = { id: "new", x: mx - size.w / 2, y: my - size.h / 2, ...size };
      if (findSpace) box = findOpenPosition(box, connectionObstacles(), 32);
      store.captureSync();
      let id: string;
      if (tool === "sticky")
        id = createSticky(editor, box.x, box.y, options.color).id;
      else if (tool === "text") {
        const textId = crud.addElement("text", {
          xywh: new Bound(box.x, box.y, size.w, size.h).serialize(),
          text: new Y.Text(),
        });
        if (!textId) return;
        id = textId;
      } else {
        const shapeId = crud.addElement("shape", {
          shapeType: getShapeType(options.shape),
          radius: options.shape === "roundedRect" ? 0.1 : 0,
          xywh: new Bound(box.x, box.y, size.w, size.h).serialize(),
          fillColor: { light: "#ffffff", dark: "#283347" },
          color: { light: "#23304a", dark: "#eef2fb" },
          strokeColor: { light: "#425574", dark: "#b9c5dc" },
          strokeWidth: 2,
          shapeStyle: ShapeStyle.General,
          filled: true,
        });
        if (!shapeId) return;
        id = shapeId;
      }
      store.captureSync();
      gfx.tool.setTool(DefaultTool);
      gfx.selection.set({ elements: [id] });
      if (findSpace) reveal(id);
      // Placed objects open ready to type, as when drawn with the pointer.
      if (tool === "sticky") startEditing(id);
      else if (tool === "text") editText(id);
      else {
        const shape = gfx.getElementById<GfxModel>(id);
        if (shape) editShape(shape);
        notify();
      }
    },
    /** Write in the selected text element (Enter). */
    editSelectedText() {
      const selected = gfx.selection.selectedElements;
      return selected.length === 1 && selected[0] instanceof TextElementModel ? editText(selected[0].id) : false;
    },
    isEditing: () => Boolean(editing) || gfx.selection.editing,
    startEditing,
    editingText,
    fitAutoNoteHeight(id: string, contentHeight: number) {
      const note = gfx.getElementById<GfxModel>(id);
      if (editing?.id !== id || !note || !editable() || item(note).locked || !("props" in note)) return;
      const current = item(note);
      if (!current.simpleSticky || current.textStyle.size !== "auto") return;
      const height = Math.ceil((contentHeight + 48) * current.textScale);
      if (height <= current.h + 1) return;
      const props = note.props as unknown as { edgeless: Record<string, unknown> };
      crud.updateElement(note.id, {
        xywh: new Bound(current.x, current.y, current.w, height).serialize(),
        edgeless: { ...props.edgeless, collapsedHeight: height / current.textScale },
      });
    },
    finishEditing(id?: string) {
      if (id && editing?.id !== id) return;
      clearEditing();
      store.captureSync();
      notify();
    },
    gridStyle() {
      let spacing = 24 * gfx.viewport.zoom;
      while (spacing < 14) spacing *= 2;
      while (spacing > 48) spacing /= 2;
      const [x, y] = gfx.viewport.toViewCoord(0, 0);
      return { spacing, x: x % spacing, y: y % spacing };
    },
    addAdjacentNote() {
      if (!editable()) return false;
      const source = editing ? gfx.getElementById<GfxModel>(editing.id) :
        gfx.selection.selectedElements.length === 1 ? gfx.selection.selectedElements[0] : null;
      if (!source || !item(source).simpleSticky || source.isLocked()) return false;
      const old = item(source);
      // Stay inside the source's frame (wrapping rows, growing the frame);
      // never cross into another frame.
      const frame = isFrame(source.group) ? (source.group as unknown as GfxModel) : null;
      const frames = gfx.gfxElements.filter((model) => isFrame(model) && model !== frame).map(item);
      const placement = nextNotePlacement(old, connectionObstacles(), frames, frame ? item(frame) : null);
      const position = placement.box;
      store.captureSync();
      const appearance = "props" in source
        ? source.props as { background?: unknown; edgeless?: Record<string, unknown> }
        : undefined;
      // Include appearance in the initial block: newly created blocks are not
      // necessarily registered in the canvas until this transaction finishes.
      let next!: ReturnType<typeof createSticky>;
      store.transact(() => {
        next = createSticky(editor, position.x, position.y, old.color, "", { w: position.w, h: position.h }, appearance);
        if (frame) {
          if (placement.frameHeight) {
            const bound = frame.elementBound;
            crud.updateElement(frame.id, { xywh: new Bound(bound.x, bound.y, bound.w, placement.frameHeight).serialize() });
          }
          const created = store.getModelById(next.id);
          if (created) (frame as unknown as { addChild?: (model: unknown) => void }).addChild?.(created);
        }
      });
      store.captureSync();
      startEditing(next.id);
      reveal(next.id);
      return true;
    },
    editNoteAtPoint(x: number, y: number) {
      const [mx, my] = gfx.viewport.toModelCoord(x, y);
      const note = gfx.getElementByPoint(mx, my);
      return note ? startEditing(note.id) || editShape(note) : false;
    },
    editSelectedShape(initialText?: string) {
      const selected = gfx.selection.selectedElements;
      return selected.length === 1
        ? editShape(selected[0], initialText)
        : false;
    },
    viewBounds(id: string) {
      const model = gfx.getElementById<GfxModel>(id);
      if (!model) return null;
      const bounds = model.elementBound;
      const [x, y] = gfx.viewport.toViewCoord(bounds.x, bounds.y);
      return {
        x,
        y,
        w: bounds.w * gfx.viewport.zoom,
        h: bounds.h * gfx.viewport.zoom,
      };
    },
    editSelectedNote(value?: string) {
      if (!editable()) return false;
      if (editing) {
        const text = editingText();
        if (value && text) store.transact(() => text.insert(value, text.length));
        return true;
      }
      const note = gfx.selection.selectedElements[0];
      if (
        !note ||
        item(note).kind !== "note" ||
        item(note).locked ||
        !("children" in note)
      )
        return false;
      return startEditing(note.id, value);
    },
    state(): CanvasState {
      const editingModel = editing && gfx.getElementById<GfxModel>(editing.id);
      if (!editingModel || !editable() || item(editingModel).locked)
        clearEditing();
      cachedItems ??= gfx.gfxElements.map(item);
      return {
        tool: toolNames[gfx.tool.currentToolName$.peek() ?? ""] ?? "select",
        zoom: gfx.viewport.zoom,
        canUndo: store.canUndo,
        canRedo: store.canRedo,
        selection: gfx.selection.selectedElements.map(item),
        items: cachedItems,
        editing: editing && editingModel ? item(editingModel) : null,
      };
    },
    selectedIds: () => gfx.selection.selectedIds,
    /** The camera as it is saved per person: model centre and zoom. */
    camera: () => ({ x: gfx.viewport.centerX, y: gfx.viewport.centerY, zoom: gfx.viewport.zoom }),
    /** View changes only (pan, zoom, selection, content), at most once per
     * frame, for overlays such as comment pins. Unlike subscribe it adds no
     * editing or label listeners. */
    subscribeView(onChange: () => void) {
      let frame = 0;
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; onChange(); });
      };
      const viewport = gfx.viewport.viewportUpdated.subscribe(schedule);
      const selection = gfx.selection.slots.updated.subscribe(schedule);
      const blocks = store.slots.blockUpdated.subscribe(schedule);
      const doc = store.spaceDoc;
      doc.on("update", schedule);
      return () => {
        cancelAnimationFrame(frame);
        viewport.unsubscribe();
        selection.unsubscribe();
        blocks.unsubscribe();
        doc.off("update", schedule);
      };
    },
    subscribe(onChange: () => void) {
      listeners.add(onChange);
      let frame = 0;
      const schedule = () => {
        if (!frame)
          frame = requestAnimationFrame(() => {
            frame = 0;
            onChange();
          });
      };
      const a = gfx.viewport.viewportUpdated.subscribe(schedule);
      const b = gfx.selection.slots.updated.subscribe(() => {
        // Shift-clicking another object while writing extends the selection;
        // it must also end the edit, as one note cannot stay a text cursor
        // inside a multi-selection.
        if (editing && (!gfx.selection.selectedIds.includes(editing.id) ||
            gfx.selection.selectedIds.length > 1))
          clearEditing();
        schedule();
      });
      const c = gfx.tool.currentToolName$.subscribe(schedule);
      const d = store.slots.blockUpdated.subscribe(() => {
        cachedItems = null;
        schedule();
      });
      const history = store.history.onUpdated.subscribe(schedule);
      const readonly = store.readonly$.subscribe(schedule);
      const doc = store.spaceDoc;
      const beginEditing = (event: Event) => {
        if (startEditing((event as CustomEvent<{ id: string }>).detail.id)) event.preventDefault();
      };
      // Paste followed immediately by Escape can beat the native label's
      // ResizeObserver. Flush its actual DOM size before the editor commits
      // its stashed bounds, so the persisted label never keeps its empty size.
      const commitConnectorLabel = (event: Event) => {
        if (!editable() || !(event.target instanceof Element)) return;
        const label = event.target.closest(".edgeless-connector-label-editor");
        const inline = label?.querySelector<HTMLElement>(".inline-editor");
        const connector = label?.closest<
          HTMLElement & { connector?: ConnectorElementModel }
        >("edgeless-connector-label-editor")?.connector;
        if (
          !inline ||
          !(connector instanceof ConnectorElementModel) ||
          !connector.text?.length
        )
          return;
        const bounds = Bound.fromCenter(
          connector.getPointByOffsetDistance(connector.labelOffset.distance),
          inline.scrollWidth,
          inline.scrollHeight,
        );
        editor.std.get(EdgelessCRUDIdentifier).updateElement(connector.id, {
          labelXYWH: bounds.toXYWH(),
        });
      };
      const documentUpdated = () => {
        cachedItems = null;
        schedule();
      };
      editor.addEventListener("whiteboard-edit-note", beginEditing);
      editor.addEventListener("blur", commitConnectorLabel, true);
      doc.on("update", documentUpdated);
      return () => {
        listeners.delete(onChange);
        // The board chrome owns editing; other subscribers (comment pins)
        // must not end an edit when they unmount.
        if (!listeners.size) clearEditing();
        cancelAnimationFrame(frame);
        a.unsubscribe();
        b.unsubscribe();
        c();
        d.unsubscribe();
        history.unsubscribe();
        readonly();
        doc.off("update", documentUpdated);
        editor.removeEventListener("whiteboard-edit-note", beginEditing);
        editor.removeEventListener("blur", commitConnectorLabel, true);
      };
    },
    selectTool,
    addNotes,
    connectNext,
    fit,
    zoom(value: number) {
      editor.dispatchEvent(new Event("whiteboard-manual-navigation"));
      // Manual zoom wins over any fit-to-content animation still in flight.
      gfx.viewport.smoothZoom(value, undefined, 1);
      gfx.viewport.setZoom(value);
    },
    undo() {
      if (!editable()) return;
      if (pendingHistoryWork) void pendingHistoryWork.then(() => { if (editable()) store.undo(); }, () => undefined);
      else store.undo();
    },
    redo() {
      if (!editable()) return;
      if (pendingHistoryWork) void pendingHistoryWork.then(() => { if (editable()) store.redo(); }, () => undefined);
      else store.redo();
    },
    async uploadImage(file: File) {
      if (!editable()) return;
      if (!file.type.startsWith("image/"))
        throw new Error("Choose an image file.");
      if (file.size > 20 * 1024 * 1024)
        throw new Error("Choose an image smaller than 20 MB.");
      const existing = gfx.gfxElements.length ? gfx.elementsBound : null;
      store.captureSync();
      const ids = await addImages(editor.std, [file], { maxWidth: 800 });
      if (!editable()) return;
      if (existing)
        store.transact(() =>
          ids.forEach((id) => {
            const model = gfx.getElementById<GfxModel>(id);
            if (model)
              crud.updateElement(id, {
                xywh: new Bound(
                  existing.x,
                  existing.y + existing.h + 96,
                  model.elementBound.w,
                  model.elementBound.h,
                ).serialize(),
              });
          }),
        );
      store.captureSync();
      if (ids.length) {
        gfx.tool.setTool(DefaultTool);
        gfx.selection.set({ elements: ids, editing: false });
        fit(ids);
      }
    },
    select(id: string) {
      gfx.tool.setTool(DefaultTool);
      gfx.selection.set({ elements: [id] });
      fit([id]);
    },
    /** Step the zoom to the next recognisable level, around the view centre. */
    zoomStep(direction: 1 | -1) {
      this.zoom(steppedZoom(gfx.viewport.zoom, direction));
    },
    fitSelection() {
      const ids = gfx.selection.selectedIds;
      if (ids.length) fit(ids);
      return ids.length > 0;
    },
    selectionContains(viewX: number, viewY: number) {
      const [x, y] = gfx.viewport.toModelCoord(viewX, viewY);
      return gfx.selection.selectedElements.length > 0 && gfx.selection.isInSelectedRect(x, y);
    },
    /** Right-click target: keep a selection that contains the point, else
     * select what is under it (or nothing on empty canvas). */
    selectForContextMenu(viewX: number, viewY: number, before: string[] = []) {
      clearEditing();
      const [x, y] = gfx.viewport.toModelCoord(viewX, viewY);
      const hits = gfx.getElementByPoint(x, y, { all: true }) as GfxModel[];
      // The engine reduces a multi-selection to the pressed object on a
      // secondary press. Right-clicking inside a selection keeps all of it.
      const previous = before.map((id) => gfx.getElementById<GfxModel>(id)).filter((model): model is GfxModel => Boolean(model));
      const union = unionBounds(previous.map((model) => model.elementBound));
      if (previous.length > 1 && union && x >= union.x && x <= union.x + union.w && y >= union.y && y <= union.y + union.h &&
          hits.some((hit) => before.includes(hit.id) || before.includes(hit.group?.id ?? ""))) {
        gfx.selection.set({ elements: before, editing: false });
        notify();
        return before;
      }
      const selected = gfx.selection.selectedElements;
      if (selected.length && (gfx.selection.isInSelectedRect(x, y) || hits.some((hit) => gfx.selection.has(hit.id)))) {
        notify();
        return selected.map((model) => model.id);
      }
      // A frame's interior counts as canvas, like right-drag panning does.
      const hit = topmostObject(hits);
      // A grouped object is selected through its outermost group.
      let target: GfxModel | null = hit;
      while (target && isGrouped(target)) target = target.group as unknown as GfxModel;
      gfx.tool.setTool(DefaultTool);
      gfx.selection.set({ elements: target ? [target.id] : [], editing: false });
      return target ? [target.id] : [];
    },
    /** Keyboard traversal: select the next/previous object in reading order. */
    selectAdjacent(direction: 1 | -1) {
      clearEditing();
      // Cheap checks only: this runs on every Tab, also on very large boards.
      const models = readingOrder(gfx.gfxElements
        .filter((model) => !isGrouped(model) && !(model instanceof ConnectorElementModel) &&
          !("props" in model && (model.props as { displayMode?: NoteDisplayMode }).displayMode === NoteDisplayMode.DocOnly))
        .map((model) => { const bound = model.elementBound; return { id: model.id, x: bound.x, y: bound.y, w: bound.w, h: bound.h }; }));
      if (!models.length) return false;
      const current = gfx.selection.selectedIds.length === 1
        ? models.findIndex((model) => model.id === gfx.selection.selectedIds[0]) : -1;
      const next = current < 0 ? (direction > 0 ? 0 : models.length - 1) : current + direction;
      if (next < 0 || next >= models.length) return false;
      gfx.tool.setTool(DefaultTool);
      gfx.selection.set({ elements: [models[next].id], editing: false });
      reveal(models[next].id);
      return true;
    },
    reorderSelection(direction: "front" | "back") {
      const selected = gfx.selection.selectedElements.filter((model) => !model.isLocked());
      if (!editable() || !selected.length) return;
      // Objects reorder among their siblings: a group's or frame's children,
      // or the top-level objects. Each sibling set moves as one block.
      const sets = new Map<GfxModel | null, GfxModel[]>();
      for (const model of selected) sets.set(model.group as GfxModel | null, [...(sets.get(model.group as GfxModel | null) ?? []), model]);
      const changes = new Map<string, string>();
      for (const [group, models] of sets) {
        const siblings = group && "childElements" in group
          ? (group as unknown as { childElements: GfxModel[] }).childElements
          : gfx.gfxElements.filter((model) => !model.group);
        const indexed = (list: GfxModel[]) => list.map((model) => ({ id: model.id, index: model.index }));
        for (const [id, index] of layerOrder(indexed(siblings), indexed(models), direction)) changes.set(id, index);
      }
      if (!changes.size) return;
      store.captureSync();
      store.transact(() => {
        for (const model of selected) {
          const index = changes.get(model.id);
          if (index) model.index = index;
        }
      });
      store.captureSync();
    },
    deleteSelection() {
      const selected = gfx.selection.selectedElements;
      if (!editable() || !selected.length || selected.some((model) => model.isLocked())) return;
      clearEditing();
      // Like the Delete key: attached connectors go with their objects.
      const ids = new Set(selected.map((model) => model.id));
      for (const model of gfx.gfxElements)
        if (model instanceof ConnectorElementModel &&
            (ids.has(model.source.id ?? "") || ids.has(model.target.id ?? ""))) ids.add(model.id);
      store.captureSync();
      store.transact(() => ids.forEach((id) => { if (gfx.getElementById(id)) crud.removeElement(id); }));
      store.captureSync();
      gfx.selection.clear();
    },
    /** End an engine text edit (text element, shape or connector label)
     * and keep what was being edited selected. */
    async exitNativeEditing() {
      const ids = [...gfx.selection.selectedIds];
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      // The editor tears down on blur, clearing the selection (and deleting
      // an empty text); once it has gone, select what is left.
      const editorOpen = () =>
        Boolean(editor.querySelector("edgeless-text-editor, edgeless-shape-text-editor, edgeless-connector-label-editor"));
      for (let frame = 0; frame < 10; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (!editorOpen()) break;
      }
      const remaining = ids.filter((id) => gfx.getElementById(id));
      gfx.selection.set({ elements: remaining, editing: false });
    },
    /** Move the view by screen pixels (positive moves content left/up). */
    panBy(dx: number, dy: number) {
      editor.dispatchEvent(new Event("whiteboard-manual-navigation"));
      gfx.viewport.smoothTranslate(gfx.viewport.centerX + dx / gfx.viewport.zoom, gfx.viewport.centerY + dy / gfx.viewport.zoom);
    },
    /** Move the selection by board units as one undoable step; rapid nudges
     * of the same selection merge into a single step. Groups and frames move
     * with their contents; attached connectors follow their objects. */
    nudge(dx: number, dy: number) {
      const selected = gfx.selection.selectedElements;
      if (!editable() || !selected.length || gfx.selection.editing || selected.some((model) => model.isLocked())) return false;
      const moved = new Set<GfxModel>(selected);
      for (const model of selected)
        if (isGfxGroupCompatibleModel(model)) for (const child of model.descendantElements) moved.add(child as GfxModel);
      const key = selected.map((model) => model.id).sort().join(",");
      const now = performance.now();
      if (startsNewStep(lastNudge, now, key)) store.captureSync();
      lastNudge = { at: now, key };
      store.transact(() => {
        for (const model of moved) {
          const bound = Bound.deserialize(model.xywh);
          bound.x += dx;
          bound.y += dy;
          if (model instanceof ConnectorElementModel) model.moveTo(bound);
          else model.xywh = bound.serialize();
        }
      });
      return true;
    },
    /** Raw style props of the selected objects, for toolbar state. */
    selectedProps() {
      return gfx.selection.selectedElements.map((model) => {
        const props = "props" in model && model.props && typeof model.props === "object"
          ? (model.props as unknown as Record<string, unknown>)
          : (model as unknown as Record<string, unknown>);
        const read = (key: string) => props[key];
        return {
          id: model.id,
          kind: item(model).kind,
          locked: model.isLocked(),
          get: read,
          hasLabel: model instanceof ConnectorElementModel ? Boolean(model.text?.length) : false,
        };
      });
    },
    /** Apply style props to the selected objects of the given kinds as one
     * undo step. The patch may depend on each object. */
    styleSelection(kinds: string[], patch: Record<string, unknown> | ((model: GfxModel) => Record<string, unknown> | null)) {
      const targets = gfx.selection.selectedElements.filter((model) => kinds.includes(item(model).kind) && !model.isLocked());
      if (!editable() || !targets.length) return;
      store.captureSync();
      store.transact(() => {
        for (const model of targets) {
          const props = typeof patch === "function" ? patch(model) : patch;
          if (props) crud.updateElement(model.id, props);
        }
      });
      store.captureSync();
      notify();
    },
    /** Write in the selection's own text: a shape's or text's content, a
     * connector's label, or a frame's or group's title. */
    editSelectionLabel() {
      const [model] = gfx.selection.selectedElements;
      const root = editor.std.view.getBlock(store.root!.id);
      if (!editable() || !model || gfx.selection.selectedElements.length !== 1 || model.isLocked() || !root) return false;
      if (model instanceof ShapeElementModel) return editShape(model);
      if (model instanceof TextElementModel) return editText(model.id);
      if (model instanceof ConnectorElementModel) { store.captureSync(); mountConnectorLabelEditor(model, root); return true; }
      if (model instanceof GroupElementModel) { mountGroupTitleEditor(model, root); return true; }
      if (isFrame(model)) { mountFrameTitleEditor(model as unknown as Parameters<typeof mountFrameTitleEditor>[0], root); return true; }
      return false;
    },
    /** Resize the selected frame to wrap its contents (and its title). */
    fitFrameToContent() {
      const [frame] = gfx.selection.selectedElements;
      if (!editable() || !frame || !isFrame(frame) || frame.isLocked()) return;
      const children = (frame as unknown as { childElements: GfxModel[] }).childElements ?? [];
      const bounds = frameFitBounds(children.map((child) => child.elementBound), 40);
      if (!bounds) return;
      store.captureSync();
      crud.updateElement(frame.id, { xywh: new Bound(bounds.x, bounds.y, bounds.w, bounds.h).serialize() });
      store.captureSync();
      notify();
    },
    /** Save the selected image as a file. */
    async downloadImage() {
      const [model] = gfx.selection.selectedElements;
      const sourceId = model && "props" in model ? (model.props as { sourceId?: string }).sourceId : undefined;
      if (!sourceId) return false;
      const blob = await store.blobSync.get(sourceId);
      if (!blob) return false;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `image.${(blob.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace("svg+xml", "svg")}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    },
    /** Rotate shapes, texts and images by a quarter turn (notes do not rotate). */
    rotateSelection(degrees = 90) {
      this.styleSelection(["shape", "text", "image"], (model) => ({
        rotate: (((model as unknown as { rotate?: number }).rotate ?? 0) + degrees) % 360,
      }));
    },
    clearSelection() {
      if (gfx.selection.selectedIds.length) gfx.selection.clear();
    },
    selectAll() {
      clearEditing();
      gfx.tool.setTool(DefaultTool);
      gfx.selection.set({ elements: gfx.gfxElements.filter(model => !model.group &&
        !("props" in model && (model.props as { displayMode?: NoteDisplayMode }).displayMode === NoteDisplayMode.DocOnly))
        .map(model => model.id), editing: false });
    },
    colorSelection(color: string) {
      if (!editable()) return;
      store.captureSync();
      store.transact(() =>
        gfx.selection.selectedElements.forEach((model) => {
          if (item(model).kind === "note" && !item(model).locked)
            crud.updateElement(model.id, {
              background: stickyPaper(color),
            });
        }),
      );
      store.captureSync();
    },
    async duplicateSelection() {
      if (!editable() || !gfx.selection.selectedElements.length) return;
      clearEditing();
      const root = editor.std.view.getBlock(
        store.root!.id,
      ) as EdgelessRootBlockComponent | null;
      if (root) {
        store.captureSync();
        // Cloning finishes asynchronously; undo waits for it so the copy is
        // one closed history step, even when Cmd/Ctrl+Z follows at once.
        const originals = [...gfx.selection.selectedElements];
        const originalIds = new Set(originals.map((model) => model.id));
        const work = duplicate(root, originals).then(() => placeCopies(originalIds, originals)).finally(() => {
          store.captureSync();
          if (pendingHistoryWork === work) pendingHistoryWork = null;
        });
        pendingHistoryWork = work;
        await work;
        notify();
      }
    },
    lockSelection() {
      if (!editable()) return;
      const notes = gfx.selection.selectedElements;
      const lock = notes.some((model) => !item(model).locked);
      // The rich editor writes straight to the note, so a locked note must
      // stop being edited.
      if (lock && editing && notes.some((model) => model.id === editing?.id))
        clearEditing();
      store.captureSync();
      store.transact(() =>
        notes.forEach((model) =>
          crud.updateElement(model.id, { lockedBySelf: lock }),
        ),
      );
      store.captureSync();
      notify();
    },
    /** Toggle a style on all text of the selected notes. */
    toggleTextMark(mark: TextMark) {
      const notes = selectedNotes();
      const on = !notes.every((model) => item(model).marks[mark]);
      formatNotes({ [mark]: on ? true : null });
    },
    /** Set the text color of the selected notes; null restores the default ink. */
    setTextColor(color: string | null) {
      formatNotes({ color });
    },
    /** Change font, size or alignment for the whole of each selected note. */
    setTextStyle(patch: Partial<StickyTextStyle>) {
      const notes = selectedNotes();
      if (!editable() || !notes.length) return;
      store.captureSync();
      store.transact(() =>
        notes.forEach((model) => {
          const edgeless = (model as unknown as { props: { edgeless?: Record<string, unknown> } })
            .props.edgeless;
          crud.updateElement(model.id, {
            edgeless: {
              ...edgeless,
              [STICKY_TEXT_STYLE_KEY]: storedStickyTextStyle({
                ...readStickyTextStyle(edgeless),
                ...patch,
              }),
            },
          });
        }),
      );
      store.captureSync();
    },
    arrange(action: Arrangement) {
      if (!editable()) return;
      const selected = gfx.selection.selectedElements.filter((model) => item(model).arrangeable);
      if (selected.length < ((action === "horizontal" || action === "vertical") ? 3 : 2)) return;
      const boxes = arrangeBoxes(selected.map(item), action);
      store.captureSync();
      store.transact(() =>
        boxes.forEach((box) =>
          crud.updateElement(box.id, {
            xywh: new Bound(box.x, box.y, box.w, box.h).serialize(),
          }),
        ),
      );
      store.captureSync();
    },
    groupSelection() {
      if (
        !editable() ||
        gfx.selection.selectedElements.length < 2 ||
        gfx.selection.selectedElements.some((model) => item(model).locked)
      )
        return;
      store.captureSync();
      editor.std.command.exec(createGroupFromSelectedCommand);
      store.captureSync();
    },
    ungroupSelection() {
      const selected = gfx.selection.selectedElements;
      if (!editable() || selected.length !== 1 || !(selected[0] instanceof GroupElementModel) ||
          item(selected[0]).kind !== "group" || selected[0].isLocked()) return;
      store.captureSync();
      editor.std.command.exec(ungroupCommand, { group: selected[0] });
      store.captureSync();
    },
    insertTemplate(kind: "brainstorm" | "retro" | "kanban" | "flow" | DemoPatternId) {
      if (!editable() || !gfx.surface) return;
      const existing = gfx.elementsBound;
      const x = existing
        ? existing.x + existing.w + 180
        : gfx.viewport.center.x - 600;
      const y = existing ? existing.y : gfx.viewport.center.y - 340;
      if (kind === "update-flow" || kind === "fifty-notes") {
        const pattern = demoPattern(kind);
        const ids: string[] = [];
        const nativeIds = new Map<string, string>();
        store.captureSync();
        store.transact(() => {
          for (const node of pattern.nodes) {
            const bounds = new Bound(x + node.x, y + node.y, node.w, node.h);
            const id = node.kind === "sticky"
              ? createSticky(editor, bounds.x, bounds.y, node.color, node.text, { w: node.w, h: node.h }).id
              : crud.addElement("shape", {
                shapeType: node.shape === "diamond" ? ShapeType.Diamond : getShapeType("roundedRect"),
                radius: node.shape === "diamond" ? 0 : 0.1,
                xywh: bounds.serialize(), text: new Y.Text(node.text),
                fillColor: { light: node.color, dark: node.color },
                color: { light: "#23304a", dark: "#23304a" },
                strokeColor: { light: "#425574", dark: "#425574" },
                strokeWidth: 1.5, shapeStyle: ShapeStyle.General, filled: true,
                fontFamily: "blocksuite:surface:Inter", fontSize: 20,
                textHorizontalAlign: "center", textVerticalAlign: "center",
                textResizing: 1, padding: [16, 18],
              });
            if (id) { nativeIds.set(node.id, id); ids.push(id); }
          }
          for (const frame of pattern.frames) {
            const id = store.addBlock("affine:frame", {
              title: new Text(frame.title),
              xywh: new Bound(x + frame.x, y + frame.y, frame.w, frame.h).serialize(),
              background: "transparent", index: gfx.layer.generateIndex(),
              childElementIds: Object.fromEntries(frame.children.flatMap(key => {
                const id = nativeIds.get(key); return id ? [[id, true]] : [];
              })),
            }, gfx.surface!.id);
            ids.push(id);
          }
          for (const edge of pattern.edges) {
            const source = nativeIds.get(edge.source), target = nativeIds.get(edge.target);
            if (!source || !target) continue;
            const id = crud.addElement("connector", {
              mode: ConnectorMode.Orthogonal, strokeWidth: 2,
              stroke: { light: "#5c6980", dark: "#aab7cf" },
              source: { id: source, position: edge.sourcePort },
              target: { id: target, position: edge.targetPort },
              rearEndpointStyle: PointStyle.Arrow,
            });
            if (id) ids.push(id);
          }
        });
        // Native label/frame layout settles on the next paint. Keep those
        // normalization updates in this insertion's undo group. Subsequent
        // authoring actions capture their own boundary before changing data.
        gfx.tool.setTool(DefaultTool);
        gfx.selection.set({ elements: [] });
        // Connector paths initialize during rendering. Fitting immediately
        // includes their temporary origin bounds on a populated board.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (editor.isConnected) fit(ids);
        }));
        return ids;
      }
      const titles =
        kind === "retro"
          ? ["Went well", "Could be better", "Next steps"]
          : kind === "kanban"
            ? ["To do", "In progress", "Done"]
            : kind === "brainstorm"
              ? ["Ideas", "Explore", "Decide"]
              : ["Start", "Review", "Decide", "Deliver"];
      const ids: string[] = [];
      const notes: string[] = [];
      store.captureSync();
      store.transact(() => {
        titles.forEach((title, column) => {
          const nx = x + column * 304;
          const children: Record<string, boolean> = {};
          const count = kind === "flow" ? 1 : 3;
          for (let row = 0; row < count; row++) {
            const note = createSticky(
              editor,
              nx + 24,
              y + 64 + row * 240,
              STICKY_COLORS[column % STICKY_COLORS.length].value,
              kind === "flow" ? title : "",
            );
            children[note.id] = true;
            notes.push(note.id);
            ids.push(note.id);
          }
          if (kind !== "flow") {
            const id = store.addBlock(
              "affine:frame",
              {
                title: new Text(title),
                xywh: new Bound(nx, y, 272, 800).serialize(),
                background: "#ffffff",
                index: gfx.layer.generateIndex(),
                childElementIds: children,
              },
              gfx.surface!.id,
            );
            ids.push(id);
          }
        });
        if (kind === "flow")
          notes.slice(1).forEach((id, i) => {
            const connector = crud.addElement("connector", {
              mode: ConnectorMode.Orthogonal,
              strokeWidth: 2,
              stroke: "#5c6980",
              source: { id: notes[i], position: [1, 0.5] },
              target: { id, position: [0, 0.5] },
              rearEndpointStyle: PointStyle.Arrow,
            });
            if (connector) ids.push(connector);
          });
      });
      store.captureSync();
      gfx.tool.setTool(DefaultTool);
      gfx.selection.set({ elements: [] });
      fit(ids);
      return ids;
    },
  };
}
export type CanvasController = ReturnType<typeof createCanvasController>;
