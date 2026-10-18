# GoDaddy launch record

The active GoDaddy release is **v0.5.0**. The package, owner-initiated upgrade and hosted installer checks passed. Merging source alone does not update a published ZIP or the hosted installer.

## v0.5.0 qualification

- Release source: `0efb02748945447ba0f07749ff6837f5ae5d876b`, preserved on main by [PR #36](https://github.com/sportwhiz/open-whiteboard/pull/36). The [release workflow](https://github.com/sportwhiz/open-whiteboard/actions/runs/39176223041) passed Cloudflare checks, browser suites, Node/MySQL packaging, restart and encrypted-recovery tests.
- The [published ZIP](https://github.com/sportwhiz/open-whiteboard/releases/download/v0.5.0/open-whiteboard-node.zip) matches the workflow artifact tested on GoDaddy. Its SHA-256 is `27df8c3037188c718dcc79d052e59e6a224b49c63f6427ff4747e085219188e1`; the release manifest carries the same digest.
- A fresh installation passed owner/MFA setup, guest permissions, WebSockets, OAuth/MCP, browser editing, duplication, dragging, zoom, cross-tab synchronization and reload persistence. A provider-confirmed restart retained sessions, boards, settings and image bytes. A deliberately lost publication response resumed the same operation.
- The existing v0.4.2 test installation upgraded through its normal owner update controls. The saved board, document epoch, settings and encrypted update connection survived. This is a feature release, with `security: false`; automatic security updates do not install it.
- The hosted installer now pins v0.5.0, with matching coding-agent instructions. Worker version `895d8df5-2377-4e21-b320-ba95a5dc61eb` passed live readiness, token connection, plan selection, disconnect and credential-clearing checks. Monitoring remained ready; its database, recipient restrictions and private email settings were preserved.
- Local validation passed 93 installer tests, the desktop/mobile installer browser suite and a Worker deployment dry run.

[Qualification evidence and test boundaries](qa/godaddy-release-v0.5.0.json). Fresh deployment used the real installer handler against GoDaddy; the hosted browser check connected and selected a plan without creating another app. Failed-startup recovery still requires republishing a working package from GoDaddy; automatic rollback has not been qualified.

The remaining sections preserve the original v0.4.2 launch evidence and the operating procedures.

## Release and application

- [x] Reviewed release source: `v0.4.2`, commit `a931201ed2e9622772829bd94947a71da2da9ed9` ([PR #32](https://github.com/sportwhiz/open-whiteboard/pull/32)). Node tests include packaged GoDaddy and full-MySQL startup, persistence, idle connections and interrupted full recovery.
- [x] Release workflow [39066101150](https://github.com/sportwhiz/open-whiteboard/actions/runs/39066101150) passed and published the immutable package. The published ZIP matches the exact artifact tested on GoDaddy: SHA-256 `16c1efd4ad471dcf20e518e8d5d94ea54d37d5b3088bca561ff64a0974c7ac12`.
- [x] A separate coding-agent installation used the official GoDaddy CLI, private JSON input and recoverable REST writes. Provider publication, health, account/MFA setup, board saves, WebSockets, guest authorization, OAuth/MCP and a provider-confirmed restart passed. Browser sign-in and the saved board passed afterward. [Evidence](qa/godaddy-agent-install.json).
- [x] The previous exact published v0.4.1 package passed fresh installation, sticky editing, Command-D duplication, dragging, zooming, collaboration, images and restart persistence. [Evidence](qa/godaddy-release-v0.4.1.json).

## Updates and recovery

- [x] A full encrypted backup of v0.4.1 was restored into a separate empty GoDaddy app. Existing sessions, fresh password sign-in, MFA, board identity/content, settings and image bytes survived. Source data was preserved and temporary recovery secrets removed. [Evidence](qa/godaddy-full-recovery.json); [recovery procedure](../tools/node-recovery/README.md).
- [x] The actual provider `GET /apps/{appId}` response has the top-level `id` required by the updater. Live connections also exercised the check. [Contract evidence](qa/godaddy-application-identity.json).
- [x] Unattended security update: the reviewed first-updater bootstrap candidate at `cb9472d97ca9a2e101087704c95a6abf11e65ed7` installed the genuine stable v0.4.1 security patch with no install request or browser open. The saved job reached success; fresh sign-in, MFA, settings, board data and exact image bytes passed afterward. The original published v0.4.0 ZIP predates this updater, so this is explicitly a bootstrap-candidate test. [Evidence](qa/godaddy-automatic-update.json).
- [x] Owner-initiated stable v0.4.1 → v0.4.2 update passed. Discard its initial response, recover the saved job, reject an invalid replacement token without losing the current connection, reconnect the same app, and verify target identity plus retained data. [Evidence](qa/godaddy-manual-update.json).

## Installer and alerts

- [x] The dedicated installer Worker is attached to `https://setup.openwhiteboard.app/`; the marketing site's routing remains separate. HTTPS `/healthz` returns `ready: true`.
- [x] All three D1 migrations are applied. Email binding, rate limits and five-minute scheduled delivery are configured; request logging is disabled. Recipient and sender are private operator settings.
- [x] The operator confirmed receipt of both the direct Cloudflare test email and the scheduled installation-failure digest on October 17, 2026. Recovery, recurrence and repeat suppression passed. [Evidence](qa/godaddy-hosted-installer.json).
- [x] Independent GitHub monitoring checks the branded `/healthz` address every ten minutes. Outage exercises created issues #26 and #29; recovery closed them. The GitHub notifications API confirmed inbox mention delivery. GitHub email delivery is unconfirmed; direct Cloudflare email delivery is confirmed. [Branded endpoint check](https://github.com/sportwhiz/open-whiteboard/actions/runs/39065767294).
- [x] Pinned v0.4.2 and matching coding-agent instructions, set `qualified: true`, passed 89 installer tests, the desktop/mobile browser suite and Worker dry run, and deployed Worker version `6ed26035-6b57-464d-8982-793a5fb7fccc`. Hosted health and the exact served agent instructions passed.
- [x] Completed a fresh installation through the actual hosted browser page. Provider completion, owner/MFA setup, update connection, app health and credential clearing passed. Board saves, WebSockets, guest authorization, OAuth/MCP and a provider-confirmed restart also passed. [Evidence](qa/godaddy-hosted-browser-install.json).

## Public website

- [x] Set the public production installer URL to `https://setup.openwhiteboard.app`, pin the final product source, and pass configuration tests plus the production build.
- [x] Deployed only `huddle-loom-site`, version `70bdba9c-c1d8-42bb-b1e0-333bcbe772f8`. The public hero, hosting and closing GoDaddy links point to live setup; following the hero link opened the working installer. All three Cloudflare destinations are unchanged. The walkthrough remains preview-only even without its query parameter. Desktop/mobile installer checks passed.

## Tested scope and limits

The guided flow uses GoDaddy's supplied published address and an existing plan with available capacity. It does not buy hosting or configure custom domains. Preview stays on its setup guide until its actual origin is configured; it does not open the production database while unconfigured. Namespace isolation and single-writer exclusion have real-database tests. An authenticated interactive GoDaddy Preview and an attached custom app domain have not been live-qualified.

Live tests used the existing broad Hosting test PAT. The nine setup and four update permissions match the API operations, but issuing and testing a token limited to exactly those permissions was not exercised. The agent path used `GDDY_PAT`; browser OAuth sign-in was not exercised. A temporary setup token is cleared by the installer; ongoing updates require a separate token, which the owner must replace when it expires.

The Node idle-connection change retires unused MySQL connections without releasing active ownership locks. Earlier v0.4.1 logs recorded two packet warnings followed by background asset retries; their provider-side cause was not established. Data checks passed. The full recovery tool supports private SQLite catalogs and bounded archives, requires maintenance downtime, and does not provide scheduled backups or automatic data rollback.

## If something breaks

Installation failures generate sanitized email reports with a support reference, failed step, error category and release. The independent monitor opens a GitHub issue for an installer outage and closes it after recovery. Agent/manual deployments do not send central installer alerts.

For a serious release problem, set the installer's `qualified` flag to `false` and redeploy it. Set `VITE_GODADDY_INSTALLER_URL` to an empty string and rebuild the marketing site to restore the walkthrough. Preserve existing app data and operation IDs; investigate before asking someone to create another app. A release pin change does not alter existing installations.
