import { describe, expect, it } from "vitest";
import { contextMenuPosition, contextMenuSections } from "./context-menu";

const note = { kind: "note", locked: false, arrangeable: true, simpleSticky: true };
const base = { editable: true, canComment: true, grid: true, mod: "⌘", shift: "⇧" };
const ids = (sections: ReturnType<typeof contextMenuSections>) => sections.flatMap((section) => section.items.map((item) => item.id));

describe("context menu decisions", () => {
  it("only shows shortcuts that do the same thing", () => {
    const items = contextMenuSections({ ...base, selection: [] }).flatMap((section) => section.items);
    expect(items.find((item) => item.id === "add-sticky")?.shortcut).toBeUndefined();
  });
  it("disables Paste when the clipboard is known to be empty", () => {
    const paste = (clipboardEmpty: boolean) => contextMenuSections({ ...base, selection: [], clipboardEmpty })
      .flatMap((section) => section.items).find((item) => item.id === "paste")!;
    expect(paste(true)).toMatchObject({ disabled: true, label: "Paste here · nothing copied" });
    expect(paste(false).disabled).toBeFalsy();
  });
  it("offers creation and view actions on empty canvas", () => {
    expect(ids(contextMenuSections({ ...base, selection: [] }))).toEqual([
      "paste", "add-sticky", "comment", "select-all", "fit-board", "zoom-reset", "grid",
    ]);
  });
  it("offers editing, clipboard, layering and delete for one note", () => {
    const actions = ids(contextMenuSections({ ...base, selection: [note] }));
    expect(actions).toEqual(["edit", "comment", "copy", "paste", "duplicate", "front", "back", "lock", "fit-selection", "delete"]);
  });
  it("adds arrangement and grouping for several objects", () => {
    const sections = contextMenuSections({ ...base, selection: [note, note] });
    const arrange = sections.find((section) => section.id === "arrange")!;
    expect(arrange.layout).toBe("icons");
    expect(arrange.items.find((item) => item.id === "arrange-left")?.disabled).toBe(false);
    expect(arrange.items.find((item) => item.id === "arrange-horizontal")?.disabled).toBe(true);
    expect(ids(sections)).toContain("group");
    expect(ids(sections)).not.toContain("edit");
  });
  it("keeps locked objects safe and offers Unlock", () => {
    const locked = { ...note, locked: true, arrangeable: false };
    const items = contextMenuSections({ ...base, selection: [locked] }).flatMap((section) => section.items);
    expect(items.find((item) => item.id === "lock")?.label).toBe("Unlock");
    expect(items.find((item) => item.id === "delete")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "edit")).toBeUndefined();
  });
  it("gives viewers only safe actions", () => {
    expect(ids(contextMenuSections({ ...base, editable: false, canComment: false, selection: [note] })))
      .toEqual(["copy", "fit-selection"]);
    expect(ids(contextMenuSections({ ...base, editable: false, canComment: false, selection: [] })))
      .toEqual(["select-all", "fit-board", "zoom-reset", "grid"]);
  });
  it("offers ungroup for a group", () => {
    expect(ids(contextMenuSections({ ...base, selection: [{ kind: "group", locked: false, arrangeable: false, simpleSticky: false }] })))
      .toContain("ungroup");
  });
});

describe("context menu position", () => {
  it("opens at the pointer and flips at the edges", () => {
    expect(contextMenuPosition({ x: 100, y: 100 }, { w: 200, h: 300 }, { w: 1000, h: 800 })).toEqual({ x: 100, y: 100 });
    expect(contextMenuPosition({ x: 900, y: 700 }, { w: 200, h: 300 }, { w: 1000, h: 800 })).toEqual({ x: 700, y: 400 });
    expect(contextMenuPosition({ x: 50, y: 790 }, { w: 200, h: 900 }, { w: 1000, h: 800 })).toEqual({ x: 50, y: 8 });
  });
  it("stays clear of the floating header and bottom bars", () => {
    const insets = { top: 80, bottom: 70 };
    expect(contextMenuPosition({ x: 100, y: 40 }, { w: 200, h: 300 }, { w: 1024, h: 768 }, 8, insets).y).toBe(80);
    expect(contextMenuPosition({ x: 100, y: 600 }, { w: 200, h: 300 }, { w: 1024, h: 768 }, 8, insets).y).toBe(300);
  });
  it("offers a quarter turn for shapes, text and images but not notes", () => {
    const one = (kind: string) => ids(contextMenuSections({ ...base, selection: [{ kind, locked: false, arrangeable: true, simpleSticky: kind === "note" }] }));
    expect(one("shape")).toContain("rotate");
    expect(one("image")).toContain("rotate");
    expect(one("note")).not.toContain("rotate");
  });
});
