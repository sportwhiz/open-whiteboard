# Development

## Requirements

Use Node 22.16 or newer within Node 22 and pnpm 10.30.3. The Node package uses Node's SQLite API. Cloudflare builds use the pinned Wrangler version in the lockfile.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @whiteboard/web exec wrangler d1 migrations apply CATALOG --local --config wrangler.local.jsonc
pnpm dev
```

The development configuration uses a local sample owner and local storage. Never publish it. To use a different Wrangler configuration, set `WHITEBOARD_WRANGLER_CONFIG` to a path relative to `apps/web`.

## Check a change

```sh
pnpm typecheck
pnpm test
pnpm typecheck:node
pnpm build
pnpm exec wrangler deploy --dry-run
```

Both type-check commands regenerate `apps/web/tsconfig.blocksuite.json` from the installed BlockSuite packages. The paths are relative to the app and assume pnpm's default store layout, so the file only changes when those packages change. Commit it with the dependency update that changed it.

Frontend builds, Worker builds, and Node packages are separate outputs. A shared service change needs checks on both adapters.

## Integration tests

With the local development server running, `pnpm --filter @whiteboard/web test:sticky http://127.0.0.1:5173` checks sticky editing, saving, automatic text sizing, formatting, duplication and undo/redo in Chromium. It exercises both Mac and Windows shortcut mappings and creates disposable local boards.

`pnpm --filter @whiteboard/web test:workflow http://127.0.0.1:5173` checks quick-action keyboard navigation and permissions, selection and grouping, continuous note creation with inherited styling, keyboard search, and view persistence across reloads. Both browser scripts accept `CHROMIUM_EXECUTABLE_PATH`; they use installed Chrome on macOS when available. The platform override checks application shortcut mappings, not native Windows browser behavior. Run the scripts sequentially against a stable dev server, without changing source files during the run.

Additional browser checks use the same local-server argument:

- `test:gestures`: actual pointer dragging, resizing, Space/Hand/right-button/wheel panning, cursor-anchored zoom, drawing, connectors, clipboard, images, persistence, and all native canvas font variants. It needs access to the existing canvas font CDN. `CANVAS_CPU_THROTTLE=4` exercises slower rendering; `CANVAS_TRACE_PATH=/tmp/canvas-trace.zip` records a Playwright trace.
- `test:collaboration-browser`: two browser identities editing concurrently, offline merge, following the final camera update, preserving the follower's own view, presentation, and live access revocation.
- `test:sticky-performance`: 200- and 1,000-note fixtures, text-measurement locality, formatting invalidation, and fit after reload. Timings are diagnostic, not portable performance thresholds.

Run clipboard scenarios sequentially: browser contexts share the operating-system clipboard. For release checks, also run the gesture and collaboration scripts against built assets served by a local Worker or Node fixture; Vite development does not apply the static production CSP. Stop the built-asset server before rebuilding its output directory.

See [End-to-end QA](end-to-end-qa.md) for the tested journeys, discovered defects, and remaining coverage limits.

Some Node suites need disposable MySQL databases. Without their test URL variables, those suites skip. Use MySQL 8.4 and databases whose names end in `_test`; the suites refuse ordinary database names.

The Node workflow in `.github/workflows/node-hosting.yml` creates these databases and provides the variables. Follow it for a complete local run. It covers adapters, catalog migrations, ownership, installation namespaces, source startup, and packaged startup with a process restart.

The Cloudflare workflow also runs native authentication, revocation, restore, browser OAuth, MCP, and a PostgreSQL authentication-adapter harness. Tests use disposable credentials, never hosting credentials.

To test native owner onboarding locally, use the fixtures and `scripts/run-auth-tests.mjs` under `apps/web`. The script starts and tears down its own local test installation. Do not run reset-capable smoke scripts against an installation with important data.

## Node package

```sh
pnpm package:node
```

The ZIP appears at `apps/web/open-whiteboard-node.zip`. It contains the prebuilt editor and server, migrations, pinned production dependency lockfile, release identity, installation guide, and license notices. Credentials and `node_modules` are excluded. The public GitHub release attaches this ZIP and its SHA-256 checksum, plus an identical `huddle-loom-node.zip` compatibility copy with its own checksum file to preserve existing download links.

## Licenses and releases

Run `node scripts/licenses.mjs` after changing dependencies. It refreshes the public dependency inventory, notices, and corresponding theme source. Keep the checked-in upstream notices in `licenses/upstream` with it. Inspect new dependencies before publishing them.

Set matching root and app versions, commit reviewed source, and tag `vX.Y.Z`. The release workflow qualifies both hosts before attaching the Node ZIP and release manifest. [Updates](software-updates.md) explains the manifest and compatibility checks.

The release workflow defaults to a preview release. Preview releases are available for manual installation and are excluded from stable automatic updates. Publish a stable release only after completing the hosting checks for the supported platforms.

GoDaddy deployment regression checks: `pnpm test:godaddy-installer` and `pnpm test:godaddy-installer:browser`. The latter uses a provider simulator. With a local frontend running, use `UI_ORIGIN=http://127.0.0.1:5192 node apps/web/scripts/godaddy-update-ui-smoke.mjs` for the update controls. `apps/web/tests/godaddy-updates.test.ts` covers the durable provider state machine. See [the qualification report](end-to-end-qa.md#guided-godaddy-deployment-and-updates) for real-hosting evidence and the public-release gate.
