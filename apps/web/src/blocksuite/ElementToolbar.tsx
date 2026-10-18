import { forwardRef, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { usePopover, focusOrFallback } from "../usePopover";
import { UiIcon } from "../UiIcon";
import { usePopoverInView } from "./popover-in-view";
import type { CanvasController } from "./canvas-controller";
import {
  CANVAS_FONTS,
  SHAPE_FILLS,
  STROKES,
  STROKE_WIDTHS,
  TEXT_COLORS,
  TEXT_SIZES,
  displayColor,
  sameColor,
  shapeChoice,
  shapeTypePatch,
  type ElementToolbarKind,
  type ShapeChoice,
  type Swatch,
} from "./element-toolbar";

type Menu = "fill" | "stroke" | "shape" | "size" | "textColor" | "align" | "mode" | "ends" | "width" | "font" | "background" | "more" | null;

const SHAPES: { id: ShapeChoice; label: string; path: ReactNode }[] = [
  { id: "roundedRect", label: "Rounded rectangle", path: <rect x="4" y="6" width="24" height="20" rx="5" /> },
  { id: "rect", label: "Rectangle", path: <rect x="4" y="6" width="24" height="20" /> },
  { id: "ellipse", label: "Ellipse", path: <ellipse cx="16" cy="16" rx="12" ry="10" /> },
  { id: "diamond", label: "Decision", path: <path d="m16 3 13 13-13 13L3 16Z" /> },
  { id: "triangle", label: "Triangle", path: <path d="m16 4 13 24H3Z" /> },
];
const MODES = [
  { id: 0, label: "Straight", d: "M4 24 28 8" },
  { id: 1, label: "Elbow", d: "M4 24h12V8h12" },
  { id: 2, label: "Curved", d: "M4 24C24 24 8 8 28 8" },
];
const ENDS = [
  { id: "none", label: "No arrowheads", front: "None", rear: "None" },
  { id: "end", label: "Arrow at the end", front: "None", rear: "Arrow" },
  { id: "both", label: "Arrows at both ends", front: "Arrow", rear: "Arrow" },
];
const ALIGNS = [
  { id: "left", label: "Align text left", icon: "alignLeft" as const },
  { id: "center", label: "Align text centre", icon: "alignCenter" as const },
  { id: "right", label: "Align text right", icon: "alignRight" as const },
];
const FRAME_BACKGROUNDS: Swatch[] = [
  { name: "No background", value: null },
  { name: "White", value: { light: "#ffffff", dark: "#202630" } },
  ...SHAPE_FILLS.slice(1, 7),
];

const Glyph = ({ children, label }: { children: ReactNode; label?: string }) => (
  <svg className="canvas-icon" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden={label ? undefined : true}>{children}</svg>
);

/**
 * The product selection toolbar for shapes, connectors, text, images,
 * frames, groups and mixed selections: one visual language with the note
 * toolbar, every change one undoable step. Anything not covered here stays
 * reachable through More › All options (the engine's own toolbar).
 */
export const ElementToolbar = forwardRef<HTMLDivElement, {
  kind: ElementToolbarKind;
  controller: CanvasController;
  dark: boolean;
  style?: CSSProperties;
  side: string;
  mod: string;
  arrange: ReactNode;
  count: number;
  onShowEngineToolbar: () => void;
  onNotice: (text: string) => void;
  host: HTMLElement;
}>(function ElementToolbar({ kind, controller, dark, style, side, mod, arrange, count, onShowEngineToolbar, onNotice, host }, ref) {
  const [menu, setMenu] = useState<Menu>(null);
  const panel = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<Exclude<Menu, null>, HTMLButtonElement | null>>>({});
  const trigger = useRef<HTMLButtonElement | null>(null);
  trigger.current = menu ? triggers.current[menu] ?? null : null;
  usePopover(panel, menu !== null, () => setMenu(null), trigger as RefObject<HTMLElement>, menu);
  usePopoverInView(panel, menu, host);
  const selected = controller.selectedProps();
  const first = selected[0];
  const get = (key: string) => first?.get(key);
  const locked = selected.length > 0 && selected.every((item) => item.locked);
  const styleKinds = kind === "mixed" ? [] : [kind];
  const apply = (patch: Record<string, unknown> | ((model: never) => Record<string, unknown> | null), close = true) => {
    controller.styleSelection(styleKinds, patch as Record<string, unknown>);
    if (close) {
      const opener = menu ? triggers.current[menu] : null;
      setMenu(null);
      focusOrFallback(opener);
    }
  };
  const toggle = (next: Exclude<Menu, null>) => setMenu((current) => (current === next ? null : next));
  const opener = (id: Exclude<Menu, null>, label: string, content: ReactNode, tip = label, extraClass = "") => (
    <button
      type="button"
      className={"canvas-icon-button small " + extraClass}
      ref={(element) => { triggers.current[id] = element; }}
      aria-label={label}
      aria-expanded={menu === id}
      data-tip={tip}
      disabled={locked}
      onClick={() => toggle(id)}
    >
      {content}
    </button>
  );
  const popover = (id: Exclude<Menu, null>, label: string, children: ReactNode, className = "") =>
    menu === id ? <div ref={panel} className={"sticky-text-popover " + className} role="group" aria-label={label}>{children}</div> : null;
  const swatches = (label: string, list: Swatch[], current: unknown, onPick: (swatch: Swatch) => void, ring = false) =>
    list.map((swatch) => (
      <button
        key={swatch.name}
        type="button"
        className={"swatch-choice" + (ring ? " ring" : "") + (swatch.value ? "" : " none")}
        aria-label={`${swatch.name} ${label}`}
        aria-pressed={sameColor(current, swatch.value)}
        title={swatch.name}
        style={{ "--swatch": swatch.value ? (dark ? swatch.value.dark : swatch.value.light) : "transparent" } as CSSProperties}
        onClick={() => onPick(swatch)}
      />
    ));
  const textControls = (sizeKey: string) => (
    <>
      <div className="sticky-text-menu">
        {opener("size", "Text size", <span className="toolbar-text-chip">Aa</span>, `Text size · ${TEXT_SIZES.find((size) => size.value === get(sizeKey))?.name ?? "Custom"}`)}
        {popover("size", "Text sizes", TEXT_SIZES.map((size) => (
          <button key={size.value} type="button" className="text-choice" aria-pressed={get(sizeKey) === size.value} onClick={() => apply({ [sizeKey]: size.value })}>{size.name}</button>
        )), "list")}
      </div>
      <button type="button" className="canvas-icon-button small" aria-label="Bold" aria-pressed={get("fontWeight") === "700"} data-tip={`Bold · ${mod}B`} disabled={locked}
        onClick={() => apply({ fontWeight: get("fontWeight") === "700" ? "400" : "700" }, false)}><UiIcon name="bold" className="canvas-icon" /></button>
      <button type="button" className="canvas-icon-button small" aria-label="Italic" aria-pressed={get("fontStyle") === "italic"} data-tip={`Italic · ${mod}I`} disabled={locked}
        onClick={() => apply({ fontStyle: get("fontStyle") === "italic" ? "normal" : "italic" }, false)}><UiIcon name="italic" className="canvas-icon" /></button>
      <div className="sticky-text-menu">
        {opener("textColor", "Text color", <><UiIcon name="textColor" className="canvas-icon" /><span className="text-color-bar" style={{ background: displayColor(get("color"), dark, "currentColor") }} /></>, "Text color", "text-color-button")}
        {popover("textColor", "Text colors", swatches("text", TEXT_COLORS, get("color"), (swatch) => apply({ color: swatch.value })))}
      </div>
      <div className="sticky-text-menu">
        {opener("align", "Text alignment", <UiIcon name={ALIGNS.find((align) => align.id === get("textAlign"))?.icon ?? "alignCenter"} className="canvas-icon" />)}
        {popover("align", "Text alignment", ALIGNS.map((align) => (
          <button key={align.id} type="button" aria-label={align.label} title={align.label} aria-pressed={get("textAlign") === align.id}
            onClick={() => apply(kind === "shape" ? { textAlign: align.id, textHorizontalAlign: align.id } : { textAlign: align.id })}>
            <UiIcon name={align.icon} className="canvas-icon" />
          </button>
        )))}
      </div>
    </>
  );
  const divider = <span className="selection-divider" />;
  const common = (
    <>
      {count > 1 ? arrange : null}
      <button type="button" className="canvas-icon-button small" aria-label="Duplicate selection" data-tip={`Duplicate · ${mod}D`} disabled={locked && kind !== "mixed"}
        onClick={() => void controller.duplicateSelection()}><UiIcon name="duplicate" className="canvas-icon" /></button>
      <button type="button" className="canvas-icon-button small" aria-label={locked ? "Unlock" : "Lock"} aria-pressed={locked} data-tip={locked ? "Unlock" : "Lock"}
        onClick={() => controller.lockSelection()}><UiIcon name="lock" className="canvas-icon" /></button>
      <div className="sticky-text-menu">
        {opener("more", "More actions", <UiIcon name="more" className="canvas-icon" />, "More")}
        {popover("more", "More actions", (
          <>
            <button type="button" className="text-choice" onClick={() => { setMenu(null); if (!document.execCommand("copy")) onNotice("Copy was blocked by the browser. Press " + mod + "C instead."); }}>Copy <kbd>{mod}C</kbd></button>
            <button type="button" className="text-choice" disabled={locked} onClick={() => { controller.reorderSelection("front"); setMenu(null); }}>Bring to front <kbd>]</kbd></button>
            <button type="button" className="text-choice" disabled={locked} onClick={() => { controller.reorderSelection("back"); setMenu(null); }}>Send to back <kbd>[</kbd></button>
            {kind === "shape" || kind === "text" || kind === "image" ? (
              <button type="button" className="text-choice" disabled={locked} onClick={() => { controller.rotateSelection(90); setMenu(null); }}>Rotate 90°</button>
            ) : null}
            <button type="button" className="text-choice" onClick={() => { setMenu(null); onShowEngineToolbar(); }}>All options…</button>
            <button type="button" className="text-choice danger" disabled={locked} onClick={() => { setMenu(null); controller.deleteSelection(); }}>Delete <kbd>{mod === "⌘" ? "⌫" : "Del"}</kbd></button>
          </>
        ), "list")}
      </div>
    </>
  );

  return (
    <div
      ref={ref}
      className="sticky-selection-actions element-toolbar"
      data-kind={kind}
      style={style}
      data-side={side}
      role="toolbar"
      aria-label={`${kind === "mixed" ? "Selection" : kind[0].toUpperCase() + kind.slice(1)} actions`}
    >
      {kind === "shape" ? (
        <>
          <div className="sticky-text-menu">
            {opener("fill", "Fill color", <span className="paper-color-chip" style={{ background: get("filled") === false ? "transparent" : displayColor(get("fillColor"), dark, "#ffffff") }} />, "Fill")}
            {popover("fill", "Fill colors", swatches("fill", SHAPE_FILLS, get("filled") === false ? null : get("fillColor"),
              (swatch) => apply(swatch.value ? { filled: true, fillColor: swatch.value } : { filled: false })))}
          </div>
          <div className="sticky-text-menu">
            {opener("stroke", "Border", <span className="stroke-chip" style={{ borderColor: displayColor(get("strokeColor"), dark, "currentColor") }} />, "Border")}
            {popover("stroke", "Border colors and widths", (
              <>
                <div className="swatch-row">{swatches("border", STROKES, get("strokeColor"), (swatch) => apply({ strokeColor: swatch.value }, false), true)}</div>
                <div className="swatch-row">{STROKE_WIDTHS.map((width) => (
                  <button key={width.value} type="button" className="text-choice compact" aria-pressed={get("strokeWidth") === width.value} onClick={() => apply({ strokeWidth: width.value })}>{width.name}</button>
                ))}</div>
              </>
            ), "stacked")}
          </div>
          <div className="sticky-text-menu">
            {opener("shape", "Shape", <Glyph>{SHAPES.find((shape) => shape.id === shapeChoice({ shapeType: get("shapeType") as string, radius: get("radius") as number }))?.path ?? SHAPES[0].path}</Glyph>)}
            {popover("shape", "Shapes", SHAPES.map((shape) => (
              <button key={shape.id} type="button" aria-label={shape.label} title={shape.label}
                aria-pressed={shapeChoice({ shapeType: get("shapeType") as string, radius: get("radius") as number }) === shape.id}
                onClick={() => apply(shapeTypePatch(shape.id))}><Glyph>{shape.path}</Glyph></button>
            )))}
          </div>
          {divider}
          {textControls("fontSize")}
          {divider}
          <button type="button" className="canvas-icon-button small" aria-label="Edit text" data-tip="Edit text · Enter" disabled={locked || count > 1}
            onClick={() => controller.editSelectionLabel()}><UiIcon name="text" className="canvas-icon" /></button>
        </>
      ) : null}
      {kind === "text" ? (
        <>
          <div className="sticky-text-menu">
            {opener("font", "Font", <span className="toolbar-text-chip">{CANVAS_FONTS.find((font) => font.value === get("fontFamily"))?.name ?? "Font"}</span>)}
            {popover("font", "Fonts", CANVAS_FONTS.map((font) => (
              <button key={font.value} type="button" className="text-choice" aria-pressed={get("fontFamily") === font.value} onClick={() => apply({ fontFamily: font.value })}>{font.name}</button>
            )), "list")}
          </div>
          {textControls("fontSize")}
          {divider}
          <button type="button" className="canvas-icon-button small" aria-label="Edit text" data-tip="Edit text · Enter" disabled={locked || count > 1}
            onClick={() => controller.editSelectionLabel()}><UiIcon name="text" className="canvas-icon" /></button>
        </>
      ) : null}
      {kind === "connector" ? (
        <>
          <div className="sticky-text-menu">
            {opener("mode", "Line style", <Glyph><path d={(MODES.find((mode) => mode.id === get("mode")) ?? MODES[1]).d} /></Glyph>)}
            {popover("mode", "Line styles", MODES.map((mode) => (
              <button key={mode.id} type="button" aria-label={mode.label} title={mode.label} aria-pressed={get("mode") === mode.id}
                onClick={() => apply({ mode: mode.id })}><Glyph><path d={mode.d} /></Glyph></button>
            )))}
          </div>
          <div className="sticky-text-menu">
            {opener("ends", "Arrowheads", <Glyph><path d="M4 16h22M20 10l6 6-6 6" /></Glyph>)}
            {popover("ends", "Arrowheads", ENDS.map((end) => (
              <button key={end.id} type="button" aria-label={end.label} title={end.label}
                aria-pressed={get("frontEndpointStyle") === end.front && get("rearEndpointStyle") === end.rear}
                onClick={() => apply({ frontEndpointStyle: end.front, rearEndpointStyle: end.rear })}>
                <Glyph><path d={end.id === "none" ? "M4 16h24" : end.id === "end" ? "M4 16h22M20 10l6 6-6 6" : "M6 16h20M12 10l-6 6 6 6M20 10l6 6-6 6"} /></Glyph>
              </button>
            )))}
          </div>
          <div className="sticky-text-menu">
            {opener("stroke", "Line color and width", <span className="line-chip" style={{ background: displayColor(get("stroke"), dark, "currentColor"), height: Math.max(2, Number(get("strokeWidth")) || 2) }} />, "Color and width")}
            {popover("stroke", "Line colors and widths", (
              <>
                <div className="swatch-row">{swatches("line", STROKES, get("stroke"), (swatch) => apply({ stroke: swatch.value }, false), true)}</div>
                <div className="swatch-row">{STROKE_WIDTHS.map((width) => (
                  <button key={width.value} type="button" className="text-choice compact" aria-pressed={get("strokeWidth") === width.value} onClick={() => apply({ strokeWidth: width.value })}>{width.name}</button>
                ))}</div>
                <div className="swatch-row">
                  <button type="button" className="text-choice compact" aria-pressed={get("strokeStyle") !== "dash"} onClick={() => apply({ strokeStyle: "solid" })}>Solid</button>
                  <button type="button" className="text-choice compact" aria-pressed={get("strokeStyle") === "dash"} onClick={() => apply({ strokeStyle: "dash" })}>Dashed</button>
                </div>
              </>
            ), "stacked")}
          </div>
          {divider}
          <button type="button" className="labelled-action" aria-label={first?.hasLabel ? "Edit label" : "Add label"} data-tip={first?.hasLabel ? "Edit label · Enter" : "Add a label"} disabled={locked || count > 1}
            onClick={() => controller.editSelectionLabel()}><UiIcon name="text" className="canvas-icon" /><span>{first?.hasLabel ? "Edit label" : "Label"}</span></button>
        </>
      ) : null}
      {kind === "image" ? (
        <button type="button" className="labelled-action" aria-label="Download image" data-tip="Download"
          onClick={() => void controller.downloadImage().then((ok) => { if (!ok) onNotice("This image could not be downloaded."); })}>
          <UiIcon name="download" className="canvas-icon" /><span>Download</span>
        </button>
      ) : null}
      {kind === "frame" ? (
        <>
          <button type="button" className="labelled-action" aria-label="Rename frame" data-tip="Rename" disabled={locked} onClick={() => controller.editSelectionLabel()}>
            <UiIcon name="text" className="canvas-icon" /><span>Rename</span></button>
          <div className="sticky-text-menu">
            {opener("background", "Frame background", <span className="paper-color-chip" style={{ background: displayColor(get("background"), dark, "transparent") }} />, "Background")}
            {popover("background", "Frame backgrounds", swatches("background", FRAME_BACKGROUNDS, get("background") === "transparent" ? null : get("background"),
              (swatch) => apply({ background: swatch.value ?? "transparent" })))}
          </div>
          <button type="button" className="labelled-action" aria-label="Fit frame to its contents" data-tip="Fit to contents" disabled={locked} onClick={() => controller.fitFrameToContent()}>
            <UiIcon name="fit" className="canvas-icon" /><span>Fit</span></button>
        </>
      ) : null}
      {kind === "group" ? (
        <>
          <button type="button" className="labelled-action" aria-label="Rename group" data-tip="Rename" disabled={locked} onClick={() => controller.editSelectionLabel()}>
            <UiIcon name="text" className="canvas-icon" /><span>Rename</span></button>
          <button type="button" className="labelled-action" aria-label="Ungroup" data-tip={`Ungroup · ${mod}⇧G`} disabled={locked} onClick={() => controller.ungroupSelection()}>
            <UiIcon name="arrange" className="canvas-icon" /><span>Ungroup</span></button>
        </>
      ) : null}
      {kind === "mixed" ? (
        <>
          <span className="selection-count" aria-live="polite">{count} selected</span>
          <button type="button" className="labelled-action" aria-label="Group selection" data-tip={`Group · ${mod}G`} disabled={locked} onClick={() => controller.groupSelection()}>
            <UiIcon name="shape" className="canvas-icon" /><span>Group</span></button>
        </>
      ) : null}
      {divider}
      {common}
    </div>
  );
});
