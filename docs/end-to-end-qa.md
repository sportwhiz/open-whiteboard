# End-to-end whiteboard QA

Date: 2026-10-17. Base: Open Whiteboard 0.4.0, `origin/main` at `0a49cb0`, in `sportwhiz/open-whiteboard`. Changes are on `codex/sticky-editing-shortcuts`.

This pass combined actual Chromium mouse/keyboard interactions, two browser identities, saved-document comparisons, browser console checks, interruption tests, API/WebSocket harnesses, and disposable database installations. Browser automation drives the UI for interaction checks; fixtures and assertions also inspect native document state to detect silent data loss. It is not a claim that every browser, device or deployment has been qualified.

## Defects found and fixed

1. **Sticky text had competing entry points.** The native document editor and the sticky overlay could both activate. The paper wrapper could also accept text that was not in the saved rich-text document. Simple stickies now have one editable region, with paper clicks focusing that region. Rich document notes retain native editing. Selected-note typing appends without erasing the idea.
2. **Duplicate and continuous capture were awkward.** Cmd/Ctrl+D now duplicates selections and supports Undo. Cmd/Ctrl+Enter creates the next note from selection or editing, and Tab continues from editing. New notes inherit appearance and dimensions, find open space, and reveal themselves without resetting zoom.
3. **Text did not fit consistently.** New notes use Auto fit; editing and display use matching typography. At the minimum readable size, the note grows instead of clipping text. Native text can mount after React's layout pass, so a batched observer also measures late-rendered text after opening a board.
4. **Space-pan stopped working after editing or search.** Focus was returned to the outer shell. It now returns to the native editor host, where navigation shortcuts are handled.
5. **Typing remeasured the whole board.** The first 200-note profile showed 1,000 sizing writes across the board and a 101 ms long task. Caching by rendered content, formatting, dimensions and font revision restricts sizing work to the changed note. A regression script covers 200 and 1,000 notes, formatting changes and reload.
6. **Followers could miss the final zoom.** Presence throttling dropped the last update inside its interval. The new throttle publishes the latest state after input stops. Reapplying identical followed camera targets is suppressed to avoid animation/presence feedback. Following preserves the user's own saved camera.
7. **Native copy/paste failed in development.** BlockSuite's CommonJS clipboard compressor needed explicit Vite dependency interop. Native object copy/paste now succeeds, including Undo and saved reload.
8. **Production blocked canvas fonts.** The engine's existing community font CDN was absent from both static and server Content Security Policies. Both now permit `https://fonts.cdnfonts.com` for fonts only. A regression test keeps the two policies identical. These extra shape/label fonts still need network access on first use; the app's own fonts are bundled.

Related usability improvements include searchable Quick actions with disabled-action explanations, complete keyboard search results, correct arrangement availability, and per-account/per-board camera restoration. See [Interaction review](interaction-review.md) for the rationale and [Using Open Whiteboard](using-open-whiteboard.md) for shortcuts.

## Coverage and results

| Area | Exercised | Result |
| --- | --- | --- |
| Unit and database suites | All 61 test files with disposable MySQL 8.4 databases; no optional database skips | 503 passed, 0 skipped in the final PR review |
| Static/build checks | Web/Worker types, Node types, production build, Wrangler deployment dry run | Passed; existing bundle-size/dynamic-import warnings remain |
| Sticky editing | Paper/text click targets, selected-note typing, multiline input, saving/reloading, formatting, Auto fit, long-note growth, fixed styles, rich-note fallback, duplicate/undo/redo | Passed in Chromium with Mac and Windows application shortcut mappings |
| Workflow navigation | Quick actions, read-only explanations, grouping/selection, inherited next-note styles, search navigation, camera persistence and manual zoom during prior camera movement | Passed |
| Pointer gestures | Actual note placement, dragging, resize/undo/redo, Space/right-button/Hand/wheel pan, cursor-anchored zoom, shape text, bound connectors after target movement, clipboard, pen, labels, frames and uploaded image | Passed in development and production builds, including 4× and 8× CPU throttling; all 29 native font variants loaded under production CSP |
| Shared editing | Two actual browser roles, simultaneous text, offline/online merge, final camera publication, feedback prevention, saved personal view, presentation and live revocation | Passed in development and production builds |
| Workshops, hands-on browser pass | Group and ungroup, comment/reply/resolve/reopen and filters, timer start/pause/extend/resume, private brainstorm submission/reveal, voting/reveal, frame presentation navigation | Passed; two participant identities used for workshop actions |
| Product and data | Catalog search/rename/favorite/move, independent board copies, archive export/import, history restore copies, malformed import rejection | Passed |
| Permissions and assets | Invitations/roles/inheritance, private activity visibility, comments/notifications, REST/snapshot/WebSocket asset ownership, copy/import isolation | Passed |
| WebSockets and stress | Origin rejection, state vectors, concurrent convergence, presence/selection, stale epochs, idempotency; 50 connections with 10 concurrent updates | Passed locally; not a deployed capacity claim |
| Loading and recovery | Lazy editor/highlighter, warm navigation/back/forward, 220 offline edits and immediate leave/recovery, retained history and restore | Passed against development fixture |
| Templates and MCP | Native patterns, 50-note case, undo/redo, persistence, dark/light/mobile views; MCP tools and authoring geometry/locking scenarios | Passed |
| Administration UI | Guided tours across Studio/board/connections/account/admin sections; updates, notices, verification policy, desktop/phone/landscape, dark/light and roles | Passed with deterministic UI API fixtures |
| Native authentication | Owner setup, MFA, admission, lifecycle, CSRF, OAuth/PKCE, providers, ownership transfer, mail/jobs, recovery, revocation and backup/restore rehearsal | Passed against isolated local Worker/D1/R2/Durable Object installation |
| Browser OAuth | Real sign-in/MFA, cancel/approve, external callback, PKCE and MCP connection | Passed |
| PostgreSQL authentication | PostgreSQL 17 schema/IDs, password/admission/MFA/expiry, atomic claims, distributed limits and transactional revocation/audit/outbox | Passed |
| Node hosting | Source startup, packaged install/build/start/restart on Node 22.23.3, private SQLite catalog plus MySQL auth and full MySQL catalog configurations | Passed |
| Anonymous guests | View/comment/edit, passwords, CSRF, board isolation, live revoke/change on both local Cloudflare and Node adapters | Passed |
| Touch emulation | 390×844 layout, sticky entry, no horizontal overflow, two-contact pinch from 100% to approximately 203% | Passed in Chromium emulation; not physical-device qualification |

## Large-board measurements

These are single local development runs on this machine, not production benchmarks or p95 latency measurements. The script types 37 characters through Playwright with no intentional delay and counts CSS sizing writes; browser/protocol scheduling is included in elapsed time.

| Automatic stickies | Time to send/process 37 characters | Sizing writes | Notes remeasured | Observed long tasks |
| --- | --- | --- | --- | --- |
| 200 | 368 ms | 5 | 1 | None during the instrumented typing interval |
| 1,000 | 1,802 ms | 105 across multiple frames | 1 | One approximately 58 ms task |

Both fixtures remeasured after a formatting change and reopened with all note text fitting. The cache removes whole-board layout measurement, but the 1,000-note result still justifies work on whole-board state enumeration/rendering. A mixed-object benchmark and long-session memory profile would be more representative than these all-sticky fixtures.

## Remaining checks and product priorities

- One Hand-tool drag under concurrent machine load fell short of the requested distance. Isolated reruns and production runs at 4× and 8× CPU throttling passed. The issue was not reproduced or attributed to a confirmed cause. Keep the slower-CPU/trace scenario available; do not treat one passing run as proof that intermittent input timing is resolved.
- Actual Windows, Safari, Firefox, iOS/Android software keyboards, stylus input and screen readers have not been qualified. Windows shortcut mapping was emulated on macOS Chrome. IME and speech-input testing still need dedicated coverage.
- Complete font self-hosting would remove the remaining first-use network dependency for native shape/label font choices. The font policy fix preserves the existing font menu and limits the allowed external source to its current host.
- Prioritize large-board responsiveness, keyboard/screen-reader completion, and touch editing before adding more toolbar controls. Bulk creation, unresolved-comment filtering, voting results, frames and timers already exist.
- A useful subsequent feature study is a paste choice for multiline lists: one note or one note per line. Validate placement, a preview for large lists, and one-step Undo before adding it.
- A real usability session is still needed to measure task completion time, wrong-mode typing, camera corrections and requests for help. Automated pointers establish behavior, not how a person experiences it.

No repository push or release was performed. Earlier hosting checks used isolated local databases. The GoDaddy qualification below adds real test deployments; it does not establish email delivery, external identity-provider configuration, or production capacity.

## Guided GoDaddy deployment and updates

The authorized GoDaddy token was used only for hosting tests. The wizard created test apps on the existing plan without purchases. The full guided flow completed publication on a disposable test app and its public `/healthz` returned 200 with `ready: true`. This live run used the candidate ZIP through an isolated local test launcher; it was not the old published v0.4.0 asset.

The published v0.4.0 asset failed GoDaddy’s supervisor health check: the app briefly served requests, then the deployment failed and rolled back. A narrowly scoped loopback GET/HEAD readiness response fixed this without relaxing application Host checks. The candidate completed publication on a second disposable test app. Owner setup and authenticator enrollment succeeded. Real Chrome interactions confirmed sticky editing, Command-D, dragging, 100% → 120% → 100% zoom, and save/reload of text and object positions.

A second candidate containing the updater replaced that populated app with a completed deployment. The existing authenticated session, owner account, board content, and positions survived. The live Updates page recognized GoDaddy and its preconfigured app ID, accepted a test update connection, saved the automatic-security preference, and omitted the credential from status. The test credential was then disconnected and automatic updates turned off. No provider token is retained by the test installation. This connection test predates the top-level `app.id` identity check added during PR review; it does not qualify that check.

Local coverage adds the real installer UI/API handler with a simulated provider (desktop/mobile, generated passphrase, copied agent instructions, wrong key, plan capacity, lost-response recovery and credential clearing); updater tests cover encryption, wrong app/preview rejection, checksum mismatch, stable upload/publication retries, expired credentials, retention-window limits, completed-job plus running-version verification, security-patch policy and owner-confirmed recovery. The update UI fixture exercises connect, opt-in, Update now, Continue, recovery confirmation, disconnect, mobile/dark/desktop layouts and CSRF. Visual inspection caught and corrected an oversized checkbox and the old manual-only onboarding guide.

The final Node 22 package smoke covers actual local MySQL, authentication/MFA, guest permissions, board saving, WebSockets, OAuth/MCP and process restart/session/key continuity. Its original manual-update expectation was updated to assert GoDaddy mode and reject enabling updates without a connection.

Release gate: `tools/godaddy-deploy/release.json` remains `qualified: false` for the old v0.4.0 asset. The launcher refuses writes until a fixed release is published, its URL/checksum and copied agent instructions are advanced, and live qualification is recorded. A public installer URL/button and a stable-release-to-stable-release unattended upgrade remain unqualified. Deterministic updater tests and a real candidate replacement do not substitute for that final rollout rehearsal.


## Deployment UX and hosting review, October 17, 2026

The marketing site now presents both hosting providers. The GoDaddy button opens a browser-only walkthrough until a qualified installer URL is configured. The walkthrough serves the real installer screens with example responses and cannot call the hosting API, including when its query string is removed. GoDaddy’s transparent GO mark identifies the provider; Open Whiteboard’s font, colors and controls carry through setup.

Setup has four visible stages, a saved-passphrase check, keyboard focus at each handoff, progress by completed step, and a numbered account-setup handoff. The coding-agent instructions sit behind a disclosure. A rejected key during installation can be replaced in the same page; the installer checks access to the existing app before resuming. A lost creation response keeps its original retry identifier. Both recovery paths were exercised together without creating another app.

Installer verification: 36 tests passed. The browser suite passed invalid-token and unavailable-plan handling, credential clearing, interrupted requests, replacement keys, the full setup flow, desktop/mobile layouts, and the preview’s update choices with zero hosting requests. The marketing production build passed. The live provider was not mutated during this design pass.

### Conditions for the public GoDaddy launch

| Area | Current behavior and remaining work |
| --- | --- |
| Published package | The old v0.4.0 ZIP remains blocked. Publish the fixed package, pin its checksum in the installer, and update the agent instructions together. The hosted installer and marketing button must point at that qualified release. |
| Unattended updates | Candidate replacement preserved populated test data. A stable release updating itself to a second stable release still needs a live rehearsal, including interruption and recovery. Keep automatic installation opt-in. |
| Backups | Recovery needs both the private SQLite catalog and managed MySQL data, including private installation keys. Establish a provider backup procedure and demonstrate a coordinated restore before describing this as suitable for important production work. An updater checkpoint is not a data backup. |
| Process replacement | The Node runtime permits one writer per data namespace. It drains work and releases ownership on shutdown; a concurrent replacement fails closed. Confirm the plan’s stop/start behavior and allow for a brief reconnect. This is not a horizontally scaled or zero-downtime deployment. |
| Storage | Keep `/private/huddle-loom`, the MySQL connection, installation keys and namespace unchanged during updates. Preview and Publish use separate namespaces because the provider storage is shared. Never use “Sync from Preview” to overwrite live settings. |
| Update authorization | The setup key is discarded; a separate encrypted key authorizes future updates. GoDaddy scopes cover the account, not one app. Expiry requires owner reconnection, and removing a local connection does not revoke the token in GoDaddy. |
| Installer interruption | Network retries and key replacement keep the same app while the tab remains open. Closing or reloading loses the in-memory checkpoint. The leave-page warning and app dashboard link help, but automatic recovery after a closed tab is not implemented. Check the existing app before starting again. |
| Hosting limits | The package follows the production dependency, assigned-port and managed-database contract. Qualify the chosen plan’s connection, memory, disk and upload limits with expected team activity. Email must use GoDaddy’s gateway; arbitrary SMTP and external database ports are restricted. |
| Custom domains | Changing the public address requires matching authentication settings and reconnecting update authorization. Recheck sign-in, passkeys and MCP after the change. Domain setup is outside the current installer. |

The installer requires a completed provider deployment and a successful live readiness check. It now also waits if GoDaddy explicitly reports the published app as stopped. Some accounts omit the published variant from status responses; that absence cannot substitute for the required deployment and readiness checks. Tests cover both cases.

Provider references: [app requirements](https://developer.godaddy.com/en/docs/api-users/hosting/app-requirements), [deployment contract](https://github.com/godaddy/nodejs-hosting-agent-skill/blob/main/skills/godaddy-nodejs-hosting/contract.md), [hosting concepts](https://developer.godaddy.com/en/docs/api-users/hosting/concepts), and [troubleshooting](https://developer.godaddy.com/en/docs/api-users/troubleshoot/hosting).

## Installer permission audit and maintainer alerts, October 17, 2026

The setup page, agent prompt, and installer guide now agree on nine Hosting scopes, including `hosting.log:read` for agent-assisted startup diagnosis. The guided browser flow does not fetch or email raw logs. A test contract maps every exercised Hosting request to its documented capability and checks the asynchronous import/publication paths. It also models GoDaddy's documented write-implies-read behavior. This is documentation-backed simulator coverage, not a new live test with a restricted token. The updater continues to use its separate four-scope checklist.

Expanding the permission list exposed nested CSS counters that incorrectly renumbered the final token step. Counters now apply only to the three top-level steps, with a browser regression check for nested rows.

The hosted installer now has anonymous incident recording, delayed batched operator emails, retry suppression, an atomic scheduler lease, failed-delivery retries, and retention. Tests cover sanitized storage, API errors, HTTP-200 failed jobs, browser timeouts, asynchronous recovery, concurrency, and readiness. New installations are refused when monitoring is unconfigured or unhealthy; existing operations can continue. Production private email configuration is never copied into frontend assets. The local Node launcher and browser-only preview do not send central failure reports.

Validation: 59 installer/monitor tests; 21 updater tests; desktop/mobile browser smoke including support references and monitoring-unavailable UI; marketing production build; Cloudflare deployment dry run; local D1 migration and Cloudflare runtime checks for health, release status, new-app blocking, origin checks, and scheduled invocation. Email provider acceptance, actual inbox delivery, production scheduler operation, and independent external uptime monitoring remain launch requirements. The public release pin is still unqualified. No public deployment was performed in this pass.

## Final PR review

The review bounded repeated update connection failures to a 20-minute window. An interrupted update then asks the owner to check the saved deployment, and Continue reuses that deployment without publishing again. A regression test covers a temporary outage, the recovery state, and successful continuation. The updater suite now has 22 tests.

The manual-install summary no longer directs people to use GoDaddy's dashboard wrapper as their app origin. The marketing build now refuses to generate a walkthrough if its preview marker cannot be inserted, keeping the static site from presenting a live credential form after a template change.

Final checks reran all 503 tests against disposable MySQL databases with no skips, Web/Worker and Node type checks, production builds, the 59 installer/monitor tests, installer desktop/mobile browser scenarios, sticky and workflow checks under Mac/Windows shortcut mappings, pointer gestures, two-browser collaboration, and update controls. Source and packaged Node startup/restart checks use disposable local databases. Existing bundle-size warnings remain. Public release qualification and monitoring activation remain the separate launch gates listed above.

## Follow-up PR review

The second review fixed two additional issues. Board search rendered every match at once; it now renders at most 50 result buttons, while keyboard traversal and page controls reach every match. The browser regression covers 125 matches, last-to-first wrapping, page boundaries, and changing the query under both shortcut mappings.

An email outage could leave new installations blocked after all queued errors resolved, because an empty queue prevented the sender from being checked again. A failing regression reproduced this. The scheduler now sends a bounded delivery check in that state, clears the failure flag only after the send succeeds, and stops checking once healthy. Resolved errors stay out of failure reports. Installer and monitor coverage now totals 60 tests.

## Review comment regressions

Update timeouts now start at each durable phase and reset on Continue. The original creation time still bounds write retries to 23 hours. A replacement process running the exact target version can verify a saved deployment after the old process timed out, without issuing a new publication. Failed release checks retry after 15 minutes; healthy checks remain daily.

Only the editor currently typing can grow an automatic sticky, after fonts settle. Its growth stays with that editor's typing undo history. The two-browser test checks delayed font loading, shared height convergence, and an observer with no new undo entries. The offline fixture now closes board sockets without closing Vite's development reload channel. Next-note creation also normalizes copied styles after copying the surrounding appearance.

Installer Continue refreshes saved operation status, including cached failures, without replacing operation IDs or retry keys. Diagnostic sessions require a successful hosting response. Unverified provider errors use bounded category counters; unknown browser timeouts cannot enter the queue. Per-caller and global throttles, queue limits, pending totals, API-error priority, capacity alerts, and renewed alerts for resolved-then-recurring failures have regression coverage. Release verification errors still report for connected attempts. Apply all installer D1 migrations before deployment.

Validation: 505 unit/database tests across 61 files with no skips; 70 installer/monitor tests; 24 updater tests included in the 505; Web/Worker and Node type checks; production product and marketing builds; installer Worker dry run; Mac/Windows sticky interaction checks; two-browser collaboration; desktop/mobile installer walkthrough. The website's seven configuration tests pass. Live hosting qualification and operator email activation remain outstanding launch gates.


## PR #20 recovery and abuse review

The full `pnpm check` passes 510 tests across 61 files, Web/Worker type checks and the production build. Node type checks and the installer Worker deployment dry run also pass. The installer suite passes 88 tests, including a simulated 1,001-session flood from one valid token (only 20 registered), concurrent registration limits, IPv6 /64 grouping, and the missing-migration gate. The updater suite passes 29 tests, including configured custom domains, rejected app-ID overrides, legacy origin matching, and origin-change reconnection.

Failed imports and deployments offer an explicit retry on the saved app after rechecking terminal status. Tests cover cancelled jobs, recovered or pending jobs, failed rechecks, and lost replacement responses with a stable retry key. The desktop browser run recovers a lost creation response, replaces an expired key, retries failed upload and publication, and finishes with one app and no repeated successful settings. The mobile preview completes without hosting requests. These fixture checks do not replace the live qualification checklist.


On October 17, 2026, a fresh authenticated `GET /v1/hosting/apps/{appId}` returned HTTP 200 with top-level `id` exactly matching the requested app, `appType: NODEJS`, `status: ACTIVE`, and `source: ZIP`. There was no `appId` alias; the self link was relative. The installer and updater tests now share the [redacted live response fixture](../tools/godaddy-deploy/fixtures/application.json). See the [recorded verification](qa/godaddy-application-identity.json), which contains no credential or real app identity.

The current update-connection handler was also exercised against the real API using a disposable in-memory SQLite catalog. Connections succeeded with the provider origin and with a simulated custom origin (`example.test`), while a mismatched configured app ID and Preview were rejected. The saved local credential was encrypted. A network guard permitted only GET requests to the existing app endpoint; no hosted settings, domains, deployments or update preferences changed. This verifies the identity field and handler behavior, including a differing origin. An actual attached custom-domain deployment and the stable-release update rehearsal remain launch checks.
