import type { Arrangement } from "./layout";

export type ContextMenuAction =
  | "edit"
  | "comment"
  | "copy"
  | "paste"
  | "duplicate"
  | "front"
  | "back"
  | "group"
  | "ungroup"
  | "lock"
  | "rotate"
  | "delete"
  | "add-sticky"
  | "select-all"
  | "fit-board"
  | "fit-selection"
  | "zoom-reset"
  | "grid"
  | `arrange-${Arrangement}`;

export type ContextMenuItem = {
  id: ContextMenuAction;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
};
export type ContextMenuSection = {
  id: string;
  label?: string;
  /** Icon-only rows (arrange) read as a compact grid. */
  layout?: "list" | "icons";
  items: ContextMenuItem[];
};

export type ContextMenuItemSummary = {
  kind: string;
  locked: boolean;
  arrangeable: boolean;
  simpleSticky: boolean;
};

export const ARRANGE_ORDER: Arrangement[] = [
  "left", "center", "right", "top", "middle", "bottom", "horizontal", "vertical", "grid",
];
export const ARRANGE_LABELS: Record<Arrangement, string> = {
  left: "Align left", center: "Align center", right: "Align right", top: "Align top",
  middle: "Align middle", bottom: "Align bottom", horizontal: "Distribute horizontally",
  vertical: "Distribute vertically", grid: "Tidy into a grid",
};

/** Minimum arrangeable objects for an arrangement. */
export const arrangeMinimum = (action: Arrangement) =>
  action === "horizontal" || action === "vertical" ? 3 : 2;

const TEXT_KINDS = new Set(["note", "shape", "text"]);

/**
 * Decide which commands a right-click offers. Objects get editing, clipboard,
 * layering, arrangement and lock actions; empty canvas gets creation and view
 * actions. Read-only people only get the view actions and copy.
 */
export function contextMenuSections({
  selection,
  editable,
  canComment,
  grid,
  mod,
  shift,
  clipboardEmpty = false,
}: {
  /** The clipboard is known to hold nothing to paste (when readable). */
  clipboardEmpty?: boolean;
  selection: ContextMenuItemSummary[];
  editable: boolean;
  canComment: boolean;
  grid: boolean;
  /** "⌘" or "Ctrl+" */
  mod: string;
  /** "⇧" or "Shift+" */
  shift: string;
}): ContextMenuSection[] {
  if (!selection.length) {
    return [
      {
        id: "create",
        items: [
          ...(editable ? [
            { id: "paste" as const, label: clipboardEmpty ? "Paste here · nothing copied" : "Paste here", shortcut: `${mod}V`, disabled: clipboardEmpty },
            { id: "add-sticky" as const, label: "Add sticky note here" },
          ] : []),
          ...(canComment ? [{ id: "comment" as const, label: "Comment here" }] : []),
        ],
      },
      {
        id: "view",
        items: [
          { id: "select-all", label: "Select all", shortcut: `${mod}A` },
          { id: "fit-board", label: "Fit board", shortcut: `${shift}1` },
          { id: "zoom-reset", label: "Zoom to 100%", shortcut: `${shift}0` },
          { id: "grid", label: grid ? "Hide grid" : "Show grid" },
        ],
      },
    ].filter((section) => section.items.length) as ContextMenuSection[];
  }
  const single = selection.length === 1 ? selection[0] : null;
  const allLocked = selection.every((item) => item.locked);
  const anyLocked = selection.some((item) => item.locked);
  const arrangeable = selection.filter((item) => item.arrangeable).length;
  const sections: ContextMenuSection[] = [];
  const primary: ContextMenuItem[] = [];
  if (editable && single && TEXT_KINDS.has(single.kind) && !single.locked && (single.kind !== "note" || single.simpleSticky))
    primary.push({ id: "edit", label: "Edit text", shortcut: "Enter" });
  if (canComment) primary.push({ id: "comment", label: "Add comment" });
  if (primary.length) sections.push({ id: "primary", items: primary });
  sections.push({
    id: "clipboard",
    items: [
      { id: "copy", label: "Copy", shortcut: `${mod}C` },
      ...(editable ? [
        { id: "paste" as const, label: clipboardEmpty ? "Paste · nothing copied" : "Paste", shortcut: `${mod}V`, disabled: clipboardEmpty },
        { id: "duplicate" as const, label: "Duplicate", shortcut: `${mod}D` },
      ] : []),
    ],
  });
  if (editable && selection.length > 1) {
    sections.push({
      id: "arrange",
      label: "Arrange",
      layout: "icons",
      items: ARRANGE_ORDER.map((action) => ({
        id: `arrange-${action}` as const,
        label: ARRANGE_LABELS[action],
        disabled: arrangeable < arrangeMinimum(action),
      })),
    });
  }
  if (editable) {
    const layer: ContextMenuItem[] = [
      { id: "front", label: "Bring to front", shortcut: "]", disabled: anyLocked },
      { id: "back", label: "Send to back", shortcut: "[", disabled: anyLocked },
    ];
    if (selection.length > 1) layer.push({ id: "group", label: "Group", shortcut: `${mod}G`, disabled: anyLocked });
    if (single?.kind === "group") layer.push({ id: "ungroup", label: "Ungroup", shortcut: `${mod}${shift}G`, disabled: single.locked });
    if (single && ["shape", "text", "image"].includes(single.kind))
      layer.push({ id: "rotate", label: "Rotate 90°", disabled: single.locked });
    layer.push({ id: "lock", label: allLocked ? "Unlock" : "Lock" });
    sections.push({ id: "layer", items: layer });
  }
  sections.push({ id: "view", items: [{ id: "fit-selection", label: "Zoom to selection", shortcut: `${shift}2` }] });
  if (editable) sections.push({ id: "delete", items: [{ id: "delete", label: "Delete", shortcut: mod === "⌘" ? "⌫" : "Del", danger: true, disabled: anyLocked }] });
  return sections;
}

/** Keep a menu fully on screen: open right/down from the pointer, flipping
 * to the other side when it would overflow, and clamp inside the margins. */
export function contextMenuPosition(
  point: { x: number; y: number },
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  margin = 8,
  /** Space taken by floating chrome at the top and bottom of the canvas. */
  insets: { top: number; bottom: number } = { top: 0, bottom: 0 },
) {
  const top = Math.max(margin, insets.top);
  const bottom = viewport.h - Math.max(margin, insets.bottom);
  const x = point.x + size.w + margin > viewport.w ? point.x - size.w : point.x;
  const y = point.y + size.h > bottom ? point.y - size.h : point.y;
  return {
    x: Math.max(margin, Math.min(x, viewport.w - size.w - margin)),
    // Below the header and above the bottom bars when it fits; a menu taller
    // than that space starts just under the header.
    y: Math.max(top, Math.min(y, bottom - size.h)),
  };
}
