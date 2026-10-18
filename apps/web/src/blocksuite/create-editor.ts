import { RefNodeSlotsProvider } from "@blocksuite/affine/inlines/reference";
import { fitCanvas } from "./canvas-layout";
import type { BoardViewport } from "./board-viewport";
import {
  CommunityCanvasTextFonts,
  DocModeProvider,
  EditorSettingExtension,
  FeatureFlagService,
  FontConfigExtension,
  ParseDocUrlExtension,
  ToolbarModuleIdentifier,
  ThemeProvider,
  ThemeService,
} from "@blocksuite/affine/shared/services";
import { themeToVar } from "@toeverything/theme/v2";
import { ColorScheme, DefaultTheme, type Color } from "@blocksuite/affine/model";
import { StdIdentifier } from "@blocksuite/std";
import type { ExtensionType, Store, Workspace } from "@blocksuite/affine/store";
import { GfxControllerIdentifier, type GfxViewInteractionConfig } from "@blocksuite/std/gfx";
import { createIdentifier } from "@blocksuite/affine/global/di";
import { BlockFlavourIdentifier } from "@blocksuite/std";
import "./editor-container";
import {
  combinedDarkCssVariables,
  combinedLightCssVariables,
} from "@toeverything/theme";

import type { WhiteboardEditorElement } from "./editor-container";
import { getViewExtensions } from "./view-extensions";
import { CanvasConnectorTool, CanvasShapeTool, StickyTool } from "./canvas-controller";
import { notePaperColor } from "./sticky-palette";
import { CanvasFontLoader } from "./canvas-font-loader";
import { CanvasNavigationTool } from "./canvas-navigation-tool";
import {
  createDocModeProvider,
  createEditorSetting,
  createParseDocUrlService,
} from "./services";

/** Note blocks resolve their paper with the note background as fallback;
 * only those colours are sticky paper. Shape fills, strokes, text and
 * connector colours never pass through the sticky palette. */
const notePaper = (color: Color, fallback: Color | undefined): Color =>
  notePaperColor(color, fallback, DefaultTheme.noteBackgrounColor);

/** Early boards stored the product's neutral line colors as light-only hex,
 * and sticky paper under several older palettes. Adapt those at render time to
 * the current theme, keeping the saved document unchanged. */
class CanvasThemeService extends ThemeService {
  override generateColorProperty(
    ...[color, fallback, ...rest]: Parameters<ThemeService["generateColorProperty"]>
  ) {
    return super.generateColorProperty(notePaper(color, fallback), fallback, ...rest);
  }
  override getColorValue(...[color, fallback, ...rest]: Parameters<ThemeService["getColorValue"]>) {
    const value = super.getColorValue(notePaper(color, fallback), fallback, ...rest);
    if (this.edgelessTheme !== ColorScheme.Dark) return value;
    return value === "#5c6980"
      ? "#aab7cf"
      : value === "#425574"
        ? "#b9c5dc"
        : value;
  }
  override getCssVariableColor(...args: Parameters<ThemeService["getCssVariableColor"]>) {
    if (args[0] === themeToVar("edgeless/frame/background/white")) {
      const theme = args[1] ?? this.theme$.value;
      return theme === ColorScheme.Dark ? "#202630" : "#ffffff";
    }
    return super.getCssVariableColor(...args);
  }
  static override setup(di: Parameters<typeof ThemeService.setup>[0]) {
    di.override(ThemeProvider, CanvasThemeService, [StdIdentifier]);
  }
}

export function createEditor(store: Store, workspace: Workspace) {
  store
    .get(FeatureFlagService)
    .setFlag("enable_advanced_block_visibility", true);
  // Canvas labels use the engine's text element editor. The document-style
  // text block offers linked-page/table actions that this whiteboard lacks.
  store.get(FeatureFlagService).setFlag("enable_edgeless_text", false);

  const editor = document.createElement(
    "whiteboard-editor",
  ) as WhiteboardEditorElement;
  editor.autofocus = true;
  editor.doc = store;
  editor.mode = "edgeless";
  // Native popovers and handles require the engine's full token set. Scope it
  // to the editor so defaults never restyle workspace or collaboration panels.
  for (const [name, value] of Object.entries(
    document.documentElement.dataset.theme === "dark"
      ? combinedDarkCssVariables
      : combinedLightCssVariables,
  )) {
    editor.style.setProperty(name, value);
  }
  editor.style.setProperty("--affine-blue", "#4262ff");
  editor.style.setProperty("--affine-primary-color", "#4262ff");
  editor.style.setProperty(
    "--affine-font-family",
    "Arial, Helvetica, sans-serif",
  );
  editor.style.setProperty(
    "--affine-note-shadow-box",
    "0 2px 5px rgb(35 48 74 / 8%)",
  );

  const commonExtensions: ExtensionType[] = [
    CanvasThemeService,
    CanvasFontLoader,
    FontConfigExtension(CommunityCanvasTextFonts),
    EditorSettingExtension({ setting$: createEditorSetting() }),
    ParseDocUrlExtension(createParseDocUrlService(workspace)),
    {
      setup: (di) => {
        di.override(DocModeProvider, createDocModeProvider(editor));
      },
    },
  ];
  editor.pageSpecs = [...getViewExtensions("page"), ...commonExtensions];
  editor.edgelessSpecs = [
    ...getViewExtensions("edgeless"),
    ...commonExtensions,
    CanvasNavigationTool,
    StickyTool,
    CanvasShapeTool,
    CanvasConnectorTool,
    {
      setup: (di) => {
        // BlockSuite 0.22 exposes the config type, but not this DI identifier
        // through its public gfx barrel.
        const noteInteraction = createIdentifier<GfxViewInteractionConfig>("GfxViewInteraction")("affine:note");
        const nativeNote = di.provider().get(noteInteraction);
        di.override(noteInteraction, {
          ...nativeNote,
          // Sticky notes keep their proportions when resized from a corner,
          // as in other whiteboards; the side handles still stretch them.
          handleResize(context) {
            const native = nativeNote.handleResize?.(context);
            const model = context.model as unknown as { children?: Array<{ flavour: string }> };
            const sticky = (model.children ?? []).length <= 1 && (model.children ?? []).every((child) => child.flavour === "affine:paragraph");
            return {
              ...native,
              beforeResize(resize) {
                native?.beforeResize?.(resize);
                // Stickies start at 208px, below the engine's 218px document-note
                // minimum, which also skewed the locked ratio.
                if (sticky) resize.set({ ...nativeNote.resizeConstraint, minWidth: 120, minHeight: 92, lockRatio: ["top-left", "top-right", "bottom-left", "bottom-right"] });
              },
            };
          },
          handleSelection(context) {
            const nativeSelection = nativeNote.handleSelection?.(context);
            return {
              ...nativeSelection,
              onSelect(selection) {
                // Secondary clicks must select/context-menu, never enter text editing.
                if (selection.event.button !== 0 || selection.event.ctrlKey) return selection.default(selection);
                if (!selection.multiSelect && selection.selected &&
                    context.gfx.selection.selectedIds.length <= 1 &&
                    (context.gfx.selection.has(context.model.id) || context.gfx.selection.editing)) {
                  // The product editor claims simple stickies synchronously.
                  // Document notes retain the engine's rich block editor.
                  const request = new CustomEvent("whiteboard-edit-note", {
                    bubbles: true, cancelable: true, detail: { id: context.model.id },
                  });
                  if (!editor.dispatchEvent(request)) return;
                }
                if (nativeSelection?.onSelect) return nativeSelection.onSelect(selection);
                return selection.default(selection);
              },
            };
          },
        });
        for (const flavour of ["group", "frame"]) {
          const id = BlockFlavourIdentifier(`affine:surface:${flavour}`);
          const identifier = ToolbarModuleIdentifier(id.variant);
          const module = di.provider().get(identifier);
          di.override(identifier, {
            ...module,
            config: {
              ...module.config,
              actions: module.config.actions?.filter(
                (action) => action.id !== "a.insert-into-page",
              ),
            },
          });
        }
      },
    },
  ];

  editor.std
    .get(RefNodeSlotsProvider)
    .docLinkClicked.subscribe(({ pageId: docId }) => {
      const target = workspace.getDoc(docId)?.getStore();
      if (!target) {
        return;
      }
      target.load();
      editor.doc = target;
    });

  return editor;
}

export function fitEditorToContent(editor: WhiteboardEditorElement, remembered?: BoardViewport | null, onApplied?: () => void) {
  let secondFrame = 0;
  const firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(() => {
      const gfx = editor.std.get(GfxControllerIdentifier);
      if (remembered) {
        gfx.viewport.setViewport(remembered.zoom, [remembered.x, remembered.y], false);
        onApplied?.();
        return;
      }
      const host = editor.closest<HTMLElement>(".editor-canvas");
      // Show the complete composition, including documents outside a frame.
      if (host && gfx.gfxElements.length) fitCanvas(host, gfx.viewport, gfx.elementsBound, false);
      onApplied?.();
    });
  });
  return () => {
    cancelAnimationFrame(firstFrame);
    cancelAnimationFrame(secondFrame);
  };
}
