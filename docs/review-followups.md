# Review follow-ups — 17 October 2026

These fixes are included in the qualified v0.5.0 release and the hosted installer. The [release record](qa/godaddy-release-v0.5.0.json) covers fresh installation and the owner-initiated v0.4.2 upgrade.

| Finding | Result |
| --- | --- |
| A failed GoDaddy startup takes the updater offline | **Open.** Automatic rollback needs a recovery process outside the failed app, or a qualified provider guarantee that startup failures preserve the previous deployment. The update screen and hosting copy now state the limitation. See [startup failures](software-updates.md#godaddy-startup-failures). |
| The app starts during an interrupted restore | Fixed: startup checks the marker under exclusive ownership before migrations or application writes. A packaged-runtime recovery test interrupts between the MySQL commit and SQLite replacement. |
| Shared installer quota blocks ongoing installs | Provider-verified attempts using their recorded token have a separate credential bucket. Public admission remains bounded and can still return “busy” under excessive traffic. IPv4/IPv6 network limits still apply. A support reference alone cannot bypass admission. |
| Clicking a multi-selected sticky opens its editor | Fixed: an existing multi-selection must narrow before editing starts. |
| New adjacent notes inherit a long note’s height | Fixed: new notes start square at the source width and keep its formatting. Preview, pointer placement and collision checks use that square size. This is also the deliberate default after a manually resized rectangular note. |
| Closing an unseen board overwrites the saved camera | Fixed: camera persistence waits until initial view restoration or fitting completes. |
| Manual zoom drifts while following someone | Fixed: toolbar and native keyboard navigation leave follow mode without restoring the old camera over the user’s new movement. |
| Any font load remeasures every automatic note | Fixed: measurement cache keys use revisions for the rendered font families. Only the author’s editing note tracks font readiness for safe height growth. |
| ZIP digest is independent of the release manifest | Fixed: publication writes `nodeSha256` into the qualified manifest; the updater requires it to match the asset digest and downloaded bytes. Existing releases are immutable. Future releases get the field through the updated publication workflow. |
| Queued updates cannot be cancelled | Fixed: cancellation competes atomically with the runner’s claim. Started operations cannot be cancelled by this control. |
| Changing `AUTH_ORIGIN` produces a 500 | Fixed: policy/install return a 409 asking the owner to reconnect. |
| A replayed restore reports success after normal app use | Fixed: app startup invalidates the completion receipt. A repeated request while the app remains stopped explicitly returns `alreadyCompleted`; after app use, empty-destination checks apply again. |
| Killed restores leave staging files | Fixed: the recovery tool removes matching abandoned regular files after obtaining exclusive ownership. It preserves restore markers. |
| Stalled maintenance uploads occupy a slot for 30 minutes | Fixed: oversized Content-Length is rejected before reading; a 30-second inactivity deadline releases stalled transfers. Rejected authentication, path, busy and oversized requests close their connections after sending the status, even when the sender leaves its body unfinished. Health/status GET and HEAD requests with bodies return 400 and close too; ordinary provider probes remain available. Active authenticated uploads retain the overall 30-minute deadline. |
| Resolved incidents consume the 5,000-row capacity | Fixed: resolved details are removed before incident admission. Unresolved reporting remains bounded. |
| Empty request body becomes a release-download error | Fixed: empty and oversized requests return 400 without contacting the provider. |
| A failed initial availability check requires reload | Fixed: “Check availability again” recovers without losing the page. |
| Installer CI misses dependency-only changes | Fixed: root package.json, pnpm-lock.yaml and the browser test package’s package.json trigger the installer workflow. |
| GoDaddy owner-only and CSRF checks lack HTTP coverage | Added packaged Node tests for all six update mutations, including authenticated owner requests with bad CSRF/origin, guest denial, and a freshly authenticated administrator who can read status but cannot mutate updates. |
| Site README checklist link crosses a Git submodule | Companion site PR uses the public repository’s direct documentation URL. |
| Site production-check caveat disappeared | The existing v0.4.2 release has completed its documented qualification, so the obsolete prelaunch warning is not restored. The card now states hosting-plan requirements, and the update copy states the remaining startup-recovery limitation. |
| Provider buttons behave differently | Companion site PR opens GoDaddy setup in a new tab, matching Cloudflare. |
| Local Node root returns readiness JSON instead of the app | Fixed: supervisor-only readiness handling excludes the configured canonical host. Normal local app requests reach application routing. |

## Remaining work and release order

- Automatic rollback remains open. Before removing the warning from the update screen or the site’s GoDaddy card, qualify recovery from a deliberately broken startup on disposable GoDaddy hosting. Review both copies together when that passes.
- Cross-server recovery needs separate qualification. The schema fingerprint includes MySQL `SHOW CREATE TABLE` output, including charset and collation defaults. A restore onto another MySQL server can refuse a compatible schema. Keep that refusal until normalization has tests across supported server configurations.
- Merge the product PR before the companion site PR. Use a merge commit to preserve the pinned product commit, or update the site’s submodule to the actual merged `main` commit after a squash/rebase. Verify the site pin is reachable from product `main` before merging the site.
- The v0.5.0 release and installer pin now deliver these fixes. Existing owners can install the feature update from Administration → Updates; merging source alone does not update their installations.

## Validation

- Application suite: 518 tests across 61 files passed.
- Installer, monitoring and recovery unit/HTTP tests: 96 passed. The maintenance test also exercises a real 30-second stalled upload, early 413 rejection, and unfinished 400/401/404/409 requests whose sockets must close within two seconds.
- Installer browser flow passed, including a failed initial availability check followed by a successful retry.
- Packaged GoDaddy-mode Node smoke passed owner/MFA setup, guest permissions, CSRF, administrator/owner update guards, boards, WebSockets, OAuth/MCP and durable restart.
- Encrypted recovery against local MySQL and SQLite passed interrupted-restore startup refusal, staging cleanup, same-archive resume, replay refusal after app use, and preserved board/account/asset data.
- Mac and Windows workflow checks passed square adjacent-note sizing, directional preview geometry and matching pointer-preview/created-note bounds.
- Mac and Windows sticky interaction scenarios passed. The asynchronous clipboard test waits for the cloned selection to settle before testing undo.
- Automatic-note performance scenarios passed at 200 and 1,000 notes. Loading an unrelated font measured no notes; typing and formatting measured only the changed note.
- Canvas gesture scenarios passed placement, pan/zoom, drag/resize, undo/redo, connectors, clipboard, drawing, images, saved reload and font variants.
- Collaboration browser tests passed saved-view preservation with delayed initial fitting, toolbar/keyboard exit from follow mode, simultaneous editing, offline merge, presentation and live revocation.
- Browser, Worker and Node TypeScript checks passed. Node packaging, Cloudflare production build and Wrangler dry-run passed.
- Companion site configuration tests: 7 passed; production build passed.

The branch has not been qualified by deploying a deliberately broken package to GoDaddy. A live rollback claim must wait for that independent recovery design and a disposable-hosting failure drill. No live hosting configuration, existing release artifact, domain, plan or email destination was changed for this review.
