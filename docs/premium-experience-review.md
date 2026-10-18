# Whiteboard experience review

Reviewed October 18, 2026. This review covers the canvas, Studio organization, and account/administration. Findings come from code inspection, browser interaction, and regression tests.

## Usability findings

Selecting, editing, arranging, navigating, and collaborating need clear entry points and reliable ways back. The review focuses on interruptions in those workflows: lost typing, overlapping menus, stale search results, and settings with no indication that they have changed.

| Area | Assessment and decision |
| --- | --- |
| Tool discovery | Keep creation tools in the left rail, selection formatting beside the selected objects, and zoom controls at the bottom. Reduce the persistent sticky toolbar's color controls to one picker. Keep advanced formatting available. Toolbar personalization is a later addition. |
| Selecting versus writing | Preserve the existing single-click selection, repeat-click/Enter editing, typing-to-edit, rich text, auto fit, and growth. Fix secondary clicks opening the text editor. Verify drag never enters edit mode and text survives blur/reload. |
| Fast creation | Existing bulk paste, templates, drag-to-place, Tab/Command-Enter continuation, duplication, and connected-note handles cover the main tasks. Test the interactions together rather than adding another creation mechanism. |
| Menus and focus | Give transient menus common outside-click/Escape behavior, focus return, arrow/Home/End navigation, and one-open-at-a-time behavior. Preserve native input/select keys. Keep persistent collaboration panels separate from transient menus. |
| Navigation | Preserve wheel pan, trackpad-style zoom at the pointer, Space/Hand/right-drag pan, overview, saved view, and fit selection. Add visible zoom presets. Recheck camera-follow behavior with two users. Input-device preference controls need a separate design and hardware test pass. |
| Arrange and diagram | Existing attached connectors, shape labels, group/ungroup, alignment/distribution, frames, and tidy layout are retained and regression-tested. More shape libraries and connector routing improvements should follow observed demand. |
| Finding content | Existing board text search, result traversal, frames, overview, and Quick actions help large boards. Fix stale Studio searches and keep result headings tied to the submitted query. Object deep links and a searchable object outline remain useful follow-ups. |
| Workshops | Open Whiteboard already has a timer, private brainstorming, voting, reactions, follow and presentations. Inspect their entry points and state transitions; improve keyboard focus on panel/subview changes and asynchronous actions. |
| Comments | Retain object/canvas anchors, replies, resolve/reopen, and mentions. Test creating and resolving a thread, and keep permission checks independent of UI visibility. |
| Presentation | Existing frame presentation, presenter handoff, laser and bring-everyone features are useful. An owner-controlled reorder interface for the presentation list remains a worthwhile follow-up. |
| Studio and organization | Add workbook rename/move, collapsible folders, workbook filtering, and recent/name sorting. Creating a workbook should immediately select it. Failed edits must retain the draft and show the error inside the dialog. |
| Administration | Keep role-filtered navigation and existing policies. Add settings search, a persistent desktop navigation column, descriptive page titles, dirty-state feedback, discard controls, and a navigation warning for unsaved policy/limit edits. Clear bulk selection when a people filter changes. |
| Connected work | Open Whiteboard supports connected-agent authoring through MCP. Bidirectional issue integrations need explicit ownership, synchronization, permission and failure semantics before implementation. |
| AI | Keep connected-agent authoring discoverable. In-app clustering, summarization and diagram generation need preview/undo, provenance and data-processing choices; they are larger product work, not a cosmetic addition to this PR. |
| Import and portability | Existing board archives and recovery paths preserve editable content. Importing third-party board exports needs representative fixtures and a visible fidelity report; do not imply lossless interoperability. |
| Accessibility and responsiveness | Test keyboard entry/exit, focus visibility, narrow layouts and both themes. A full screen-reader audit, touch/stylus hardware testing, reduced-motion review and shortcut-disabling preferences remain separate qualification work. |

## Changes in this PR

- A compact note-color picker replaces six permanently exposed color buttons. Text formatting stays available without opening a general settings panel.
- Shared popover behavior covers sticky formatting, creation palettes, arrange, zoom, appearance, board overflow, Studio board actions, account and notifications.
- Zoom options include 25%, 50%, 100% and 200% presets alongside fit board/selection.
- Secondary-click selection cannot open a sticky's inline editor. Formatting popovers stay above the editing overlay, including when applying a color to selected text.
- The grid preference survives reopening a board. Read-only transitions preserve Quick actions so search and navigation remain available.
- Workshop subviews take keyboard focus, and completed actions return focus to a usable control or heading.
- Workbook owners can rename or move a workbook to one of their own folders. The operation does not modify board membership or resource grants. Editors/viewers and selected-resource grants cannot bypass owner/resource checks.
- Studio supports workbook/folder filtering, folder collapse, and board sorting. New workbooks become the selected view. Failed renames keep the draft open. Search responses cannot replace a subsequently selected view.
- Settings navigation can be filtered and remains available while scrolling on desktop. Policy and usage-limit forms show unsaved changes, offer discard, disable unchanged submissions, and warn on browser navigation while dirty.
- New browser regression coverage exercises desktop and narrow layouts, menu focus, workbook organization, and failed-save recovery. The CI workflow runs it against the real local Worker/catalog.

## Review follow-ups

- Moving a public sticky into a private idea now reads its current text and checks it against the saved board. Draft creation and sticky removal commit together. A stale request leaves the public note intact, and retrying a completed request cannot create another draft.
- Folder deletion records its Undo contents in the same transaction as the move. Restore commits the folder and its contents together, skips placements that would create a cycle, and falls back to the top level if the previous parent was deleted. A failed catalog refresh still leaves Undo available.
- Raised-hand departure times survive a room restart, including socket errors. Writing presence refreshes during a long private draft. Voting progress counts people allowed to vote, and email addresses no longer trigger mention highlights.
- Settings search also focuses and highlights matches on Connected apps. Right-drag navigation interrupts a pending fit animation so the animation cannot move the camera back during a drag.
- Studio return navigation is scoped to the signed-in account. Moving between admin pages clears the people selection so bulk actions only apply to the people shown.
- The mention picker cannot take focus back after Escape or overwrite a later caret position. Browser checks await clipboard results, and comment Escape coverage distinguishes dismissing suggestions, leaving a draft, and closing the panel.

## Prioritization after this pass

1. Test with people unfamiliar with the product. Ask them to create a board, write three notes, connect two, invite someone, run a short vote, and find their board again. Measure completion and recovery, not just preference ratings. Include keyboard-only and screen-reader participants.
2. Add presentation ordering and object deep links. These improve explaining and revisiting real work without adding many controls.
3. Test large-board navigation and input-device preferences on physical trackpads, mice, touch screens and styluses. Simulated wheel/pinch events do not establish hardware parity.
4. Expand organization after observing actual collection sizes: list view, nested folder behavior, folder rename/removal and bulk board organization. Keep move and share as distinct operations with explicit permission consequences.
5. Treat Issue-tracker and knowledge-base synchronization, richer diagram libraries and AI clustering as separately designed features. Define conflict resolution, undo boundaries, credential handling and failure recovery before exposing them.

## Verification record

The starting point was main at `ecb9ebf` (the merged review follow-ups). Verification used disposable local data, except for read-only inspection of the existing Node admin pages.

- `pnpm typecheck` and `pnpm typecheck:node`: passed.
- `pnpm test` with the local MySQL fixtures enabled: 519 tests passed across 62 files, none skipped.
- Cloudflare production build and Wrangler dry-run: passed. Node production package build/validation: passed. The existing large editor chunk warning remains.
- `premium-ux-smoke.mjs`: real local Worker/catalog, light desktop (1440px) and dark narrow layout (390px). Workbook rename/move and folder collapse; menu keyboard/focus; failed rename draft retention; stale search cancellation; zoom and color popovers; selected-text color application; paper color; right click; timer and comment flows.
- `sticky-interaction-smoke.mjs`: paper clicks, typing, multiline paste, formatting, duplication, undo/redo, auto-fit, resizing, Tab, multi-selection, save/reload and rich-note fallback. Both Mac and Windows shortcut conventions were exercised in Chromium on macOS, not on a physical Windows machine.
- `canvas-gesture-smoke.mjs`: drag/resize, undo/redo, Space/right-drag/Hand/wheel pan, pointer-anchored zoom, shape text, attached connectors, clipboard, drawing, frame creation, image upload and persisted reload.
- `workflow-interaction-smoke.mjs`: Quick actions, grouping/tidy, quick-create style/zoom, paged search, and camera persistence. Both shortcut conventions passed.
- `collaboration-browser-smoke.mjs`: two roles, simultaneous typing, offline merge, font-ready layout, observer undo isolation, following, presentation and revocation.
- `reauthentication-ui-smoke.mjs`: isolated API fixtures, light/dark/mobile, settings search, cancelled navigation retaining edits, dirty/discard/save, policy and limit payloads, reload. These tests do not change a live security policy.
- Manual computer interaction: created a review board; typed, duplicated and dragged notes; used color and zoom menus with keyboard input; inspected Studio, workbook settings and admin; started/paused/stopped a timer; created a comment. Screenshots were inspected for desktop and narrow layouts.

The automated interaction suite is now included in CI. This is not a complete screen-reader, browser-engine, physical touch-device certification. The roadmap above records those limits explicitly.

### Review-fix validation

The October 18 follow-up passed `pnpm check` (759 tests passed; 43 skipped), Node type checking, the Node package build and package validation, and the Cloudflare deployment dry-run. The installer suite passed all 93 tests. Docker was unresponsive, so the MySQL integration fixtures were not rerun locally; the Node CI job runs those fixtures.

Browser checks passed for Studio in light desktop and dark mobile layouts, settings and admin page selection, the complete canvas workflow under both shortcut conventions, sticky editing, canvas gestures, and two-person collaboration. The workflow passed twice after the right-drag fix. The collaboration run includes moving a newly edited public note into a private draft, comment mention selection and Escape, offline merge, presentation, voting, and live access revocation. These runs use Chromium on macOS; simulated Windows shortcuts do not constitute Windows hardware coverage.
