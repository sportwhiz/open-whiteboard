# Whiteboard interaction review

Reviewed against Open Whiteboard 0.4.0 (`0a49cb0`, latest `origin/main` when this work began).

## Approach

The core workflow is: capture an idea, continue writing, organize related ideas, find something later, discuss it, and return to work. Judge improvements by interruptions removed from that sequence. A feature count alone misses problems such as two competing text editors or a camera that changes zoom every time someone adds a note.

This review combined code inspection, browser interaction, and saved-data checks to identify interruptions in everyday board workflows.

## What the app already has

The existing product includes multi-selection, grouping, alignment and distribution, grid arrangement, native connectors, connected next steps, frames, templates, bulk sticky creation, board search and an overview map. Collaboration includes comments, a timer, voting, presentation and following another participant. History, editable archives, local pending edits and recovery support continuity. The latest administration and installation features remain in this branch's base.

These are substantial capabilities. Several were hard to discover or awkward to combine, so this change connects existing tools before introducing additional systems.

## Changes implemented

| Workflow | Observed friction | Result |
| --- | --- | --- |
| Write a sticky | Native document editing and product sticky editing could both handle the same note; the paper around the inner editor could become another editable region. | One editor owns a simple sticky. Paper clicks focus its text. Rich document notes retain their native editor. Typing on a selected sticky appends instead of replacing the existing idea. |
| Read while writing | Editing and display used different font/layout behavior, and long content could outgrow the paper. | Editing and display share typography and scale. New stickies use Auto fit, with a 12 px minimum in note coordinates and height growth after that. Existing fixed sizes stay intact. |
| Reuse an idea | The displayed duplicate shortcut did not work reliably through the product shell. | Cmd/Ctrl+D duplicates the selection, preserves formatting, and forms an undoable action. Typing in fields and dialogs does not invoke it. |
| Keep brainstorming | The next-note action required editing, reset dimensions/styles, and could refit the camera. | Cmd/Ctrl+Enter works from selection or editing; Tab still works while editing. The next note inherits appearance and dimensions, finds open space, focuses its text, and pans only as needed. Connected next steps also preserve appearance and zoom. |
| Discover and organize | Useful actions were spread across tools and selection menus. Arrangement availability counted objects that the operation would ignore. | Cmd/Ctrl+K opens searchable Quick actions. Keyboard navigation, focus return and unavailable-action explanations are included. Alignment/distribution availability now counts eligible unlocked, ungrouped objects. |
| Find an idea | Search required clicking results and silently displayed only the first 100 matches. | Enter/Down and Shift+Enter/Up cycle results, show the current result number and scroll it into view. Escape returns focus to the board. All matches are reachable; at most 50 result buttons render at once, with page controls and keyboard traversal across pages. |
| Resume work | Opening a board refit its contents instead of returning to the user's place. | Device-local position and zoom are stored per account, board and document epoch. Leaving immediately flushes the latest view. Following another participant preserves the user's own camera. A restore starts a fresh view. |
| Return to navigation | Leaving the sticky editor or search focused the outer shell, so Space-to-pan stopped working. | Focus now returns to the native editor host. Real pointer tests cover both transitions. |
| Type on a crowded board | Every automatic sticky was remeasured while editing one note; native text mounting after React could leave a reopened note unmeasured. | Measurements are cached by rendered content, formatting, dimensions and font revision. A batched observer catches native text mounting. Only the changed note is remeasured during typing. |
| Follow a collaborator | Throttling could drop the final camera update, leaving followers at the previous zoom. Repeated identical targets could restart the animation. | Presence coalesces and sends the latest state after input stops; unchanged follow targets do not restart camera movement. |
| Copy and choose fonts | Development clipboard compression failed because of CommonJS interop; production CSP blocked the engine's existing font CDN. | Explicit dependency interop restores native copy/paste. Static and server policies allow the existing host for fonts only, and a test keeps those policies consistent. |
| Control the camera | A fit/search animation could finish after a manual zoom and override it. | Manual zoom and next-note reveal cancel the older camera animation. |

The command menu uses the existing editor and permission checks. Viewers can navigate and search; editing actions explain that edit access is required. These changes do not introduce a new document format or server-side preference migration.

## Next priorities

These are proposed follow-up work, not completed features or confirmed defects unless explicitly stated.

### 1. Validate fast interaction on large boards

The end-to-end pass found and fixed full-board Auto fit remeasurement. The new cache keeps sizing writes on the changed note, including with 1,000 automatic stickies. The 1,000-note fixture still takes noticeably longer to process typing; state enumeration and search rendering deserve further profiling. See the measured results and limits in [End-to-end QA](end-to-end-qa.md).

Measure 50, 200 and 1,000 mixed objects on a representative laptop: key-to-paint latency, paste time, selection/drag smoothness, search latency and memory after repeated board navigation. Track p50/p95 rather than just average load time. The content/format/dimension/font cache is implemented; consider narrower state subscriptions and windowed search results if profiling justifies them. The acceptance check is that typing one note does not cause full-board text measurement and that every search result remains keyboard-reachable.

### 2. Finish the keyboard and assistive-technology path

The command menu and search now provide a useful keyboard route. Next, audit every toolbar, popover, object-selection transition and modal with a screen reader and keyboard only. Include focus after delete, undo, permission changes and restoration. Announce selected-object counts and action results without narrating every canvas update. Test input composition, speech input, non-Latin text, browser zoom, reduced motion and high contrast. Acceptance: create, edit, arrange, find, comment and return to a board without a pointer or lost focus.

### 3. Make note capture work across input sources

Bulk sticky creation already exists; the next useful improvement is a clear paste choice for a multiline list: keep it in one note or create one note per line. Preserve ordinary paste while editing and preview large imports before placing them. Follow with copy/paste checks across boards and applications, including multiline text, links, images and formatted content. Acceptance: no lost text, no unexpected explosion of objects, predictable placement and one Undo for each import.

### 4. Connect workshop outcomes to the board

Avoid duplicating existing voting, comments, frames and timer features. Test the full facilitator journey: prepare sections, invite a viewer/editor, start a timer, gather votes, find unresolved comments, and present the result. Unresolved/resolved comment filters and voting results already exist and were exercised. A useful next study is whether explicit next-action notes linked to their source make outcomes easier to revisit. Prioritize whichever step user sessions show is slowest. Acceptance: a participant can locate the current activity and a facilitator can return to the resulting decisions after the session.

### 5. Prove recovery and collaboration under interruption

Existing local recovery is valuable, but sticky editing should also be exercised while disconnected and while another person changes the same note. Test disconnect/reconnect, closing immediately after typing, storage failure, access revocation, restoring a revision while another tab is open, and concurrent sizing/formatting. Also verify that leaving while following a presenter reopens at the user's own view. Acceptance: acknowledged edits survive reload; unsynced edits remain recoverable; save status never implies a server acknowledgement that did not happen.

### 6. Test touch as its own workflow

Desktop modifier shortcuts cannot establish tablet quality. Test tap-to-select versus tap-to-edit, pinch zoom, panning during editing, stylus input, the software keyboard covering the selected note, and toolbar reachability. Acceptance: editing does not accidentally drag a note, the caret remains visible, and users can finish or continue an idea without a hardware keyboard.

## Validation and limits

Automated coverage is described in [Development](development.md). Unit tests cover view validation/storage behavior and the minimal-pan geometry. Browser scenarios cover note editing and persistence, duplicate/undo/redo, Auto fit, rich-note fallback, quick actions, selection/grouping, inherited styles, search navigation and camera restoration.

The browser scenarios run Chromium on macOS with both Mac and Windows application shortcut mappings. This does not establish native Windows, Safari, tablet or screen-reader behavior. The extended pass exercised 200/1,000-note boards, workshop features, concurrent editing and offline recovery. Long-session performance, physical devices and assistive-technology checks remain follow-up validation; the detailed evidence and limits are in [End-to-end QA](end-to-end-qa.md). Local browser read-only coverage exercises the UI and editor guard; existing server access-control tests remain responsible for authorization.

## Success measures for a usability session

Give participants the same short tasks before and after the change: create ten ideas, revise a long note, duplicate and group three ideas, find a named idea on a crowded board, and leave/reopen the board. Record completion time, extra clicks, wrong-mode typing, lost or overwritten text, camera corrections and requests for help. Ask where they expected the next action to be. Use those observations to choose the next improvement rather than adding controls speculatively.
