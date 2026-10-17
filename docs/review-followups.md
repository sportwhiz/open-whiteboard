# Review follow-ups — 17 October 2026

This change is for review. It has not been deployed, and the existing v0.4.2 installer release remains pinned.

| Finding | Result |
| --- | --- |
| A failed GoDaddy startup takes the updater offline | **Open.** Automatic rollback needs a recovery process outside the failed app, or a qualified provider guarantee that startup failures preserve the previous deployment. The update screen and hosting copy now state the limitation. See [startup failures](software-updates.md#godaddy-startup-failures). |
| The app starts during an interrupted restore | Fixed: startup checks the marker under exclusive ownership before migrations or application writes. A packaged-runtime recovery test interrupts between the MySQL commit and SQLite replacement. |
| Shared installer quota blocks ongoing installs | Provider-verified attempts using their recorded token have a separate credential bucket. Public admission remains bounded and can still return “busy” under excessive traffic. IPv4/IPv6 network limits still apply. A support reference alone cannot bypass admission. |
| Clicking a multi-selected sticky opens its editor | Fixed: an existing multi-selection must narrow before editing starts. |
| New adjacent notes inherit a long note’s height | Fixed: new notes start square at the source width and keep its formatting. |
| Closing an unseen board overwrites the saved camera | Fixed: camera persistence waits until initial view restoration or fitting completes. |
| Manual zoom drifts while following someone | Fixed: toolbar and native keyboard navigation leave follow mode without restoring the old camera over the user’s new movement. |
| Any font load remeasures every automatic note | Fixed: measurement cache keys use revisions for the rendered font families. Only the author’s editing note tracks font readiness for safe height growth. |
| ZIP digest is independent of the release manifest | Fixed: publication writes `nodeSha256` into the qualified manifest; the updater requires it to match the asset digest and downloaded bytes. Existing releases are immutable. Future releases get the field through the updated publication workflow. |
| Queued updates cannot be cancelled | Fixed: cancellation competes atomically with the runner’s claim. Started operations cannot be cancelled by this control. |
| Changing `AUTH_ORIGIN` produces a 500 | Fixed: policy/install return a 409 asking the owner to reconnect. |
| A replayed restore reports success after normal app use | Fixed: app startup invalidates the completion receipt. A repeated request while the app remains stopped explicitly returns `alreadyCompleted`; after app use, empty-destination checks apply again. |
| Killed restores leave staging files | Fixed: the recovery tool removes matching abandoned regular files after obtaining exclusive ownership. It preserves restore markers. |
| Stalled maintenance uploads occupy a slot for 30 minutes | Fixed: oversized Content-Length is rejected before reading; a 30-second inactivity deadline releases stalled transfers. Active large uploads retain the overall 30-minute deadline. |
| Resolved incidents consume the 5,000-row capacity | Fixed: resolved details are removed before incident admission. Unresolved reporting remains bounded. |
| Empty request body becomes a release-download error | Fixed: empty and oversized requests return 400 without contacting the provider. |
| A failed initial availability check requires reload | Fixed: “Check availability again” recovers without losing the page. |
| Installer CI misses dependency-only changes | Fixed: root package.json, pnpm-lock.yaml and the browser test package’s package.json trigger the installer workflow. |
| GoDaddy owner-only and CSRF checks lack HTTP coverage | Added packaged Node tests for all six update mutations, including authenticated owner requests with bad CSRF/origin, guest denial, and a freshly authenticated administrator who can read status but cannot mutate updates. |
| Site README checklist link crosses a Git submodule | Companion site PR uses the public repository’s direct documentation URL. |
| Site production-check caveat disappeared | The existing v0.4.2 release has completed its documented qualification, so the obsolete prelaunch warning is not restored. The card now states hosting-plan requirements, and the update copy states the remaining startup-recovery limitation. |
| Provider buttons behave differently | Companion site PR opens GoDaddy setup in a new tab, matching Cloudflare. |
| Local Node root returns readiness JSON instead of the app | Fixed: supervisor-only readiness handling excludes the configured canonical host. Normal local app requests reach application routing. |

## Validation

- Application suite: 516 tests across 61 files passed.
- Installer, monitoring and recovery unit/HTTP tests: 96 passed. The maintenance test also exercises a real 30-second stalled upload and early 413 rejection.
- Installer browser flow passed, including a failed initial availability check followed by a successful retry.
- Packaged GoDaddy-mode Node smoke passed owner/MFA setup, guest permissions, CSRF, administrator/owner update guards, boards, WebSockets, OAuth/MCP and durable restart.
- Encrypted recovery against local MySQL and SQLite passed interrupted-restore startup refusal, staging cleanup, same-archive resume, replay refusal after app use, and preserved board/account/asset data.
- Mac and Windows sticky interaction scenarios passed. The asynchronous clipboard test waits for the cloned selection to settle before testing undo.
- Automatic-note performance scenarios passed at 200 and 1,000 notes. Loading an unrelated font measured no notes; typing and formatting measured only the changed note.
- Canvas gesture scenarios passed placement, pan/zoom, drag/resize, undo/redo, connectors, clipboard, drawing, images, saved reload and font variants.
- Collaboration browser tests passed saved-view preservation with delayed initial fitting, toolbar/keyboard exit from follow mode, simultaneous editing, offline merge, presentation and live revocation.
- Browser, Worker and Node TypeScript checks passed. Node packaging, Cloudflare production build and Wrangler dry-run passed.
- Companion site configuration tests: 7 passed; production build passed.

The branch has not been qualified by deploying a deliberately broken package to GoDaddy. A live rollback claim must wait for that independent recovery design and a disposable-hosting failure drill. No live hosting configuration, existing release artifact, domain, plan or email destination was changed for this review.
