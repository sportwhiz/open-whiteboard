# GoDaddy public launch checklist

Merging the implementation PRs does not enable live GoDaddy installation. This is the remaining launch checklist. Leave every item unchecked until its evidence is recorded below. The owner of this work is the maintainer running the release with their coding agent; merging a PR does not transfer these tasks to an automatic workflow.

Current state: the website opens a preview, the installer pins the failing v0.4.0 ZIP with `qualified: false`, and production alerts and independent uptime monitoring are not activated. Local tests and candidate hosting tests have passed; they do not complete the live checks below.

## 1. Merge the reviewed code

- [ ] Require the latest checks to pass on [product PR #20](https://github.com/sportwhiz/open-whiteboard/pull/20), then merge it.
- [x] Merge the preview website: [website PR #3](https://github.com/sportwhiz/huddle-loom-site/pull/3) merged on October 17, 2026 as `80b3e1d9c8c0ff68840fbb68730c41e14a3c9a25`; its Cloudflare build passed. The public GoDaddy link still opens the preview.
- [ ] After product PR #20 merges, point the website submodule at the actual product commit on main, especially if it was squash-merged. Use a follow-up site PR and require its checks to pass. Merging the preview site first does not require a rollback.
- [ ] Keep `VITE_GODADDY_INSTALLER_URL` unset. The website may publish its preview at this point; live setup remains closed.
- [ ] Resolve the existing MCP SDK high-severity advisories before public launch. Review the upgrade in [maintenance PR #15](https://github.com/sportwhiz/open-whiteboard/pull/15) against the merged code; do not assume another branch's fix is included.

Done when: the merged commits and passing checks are recorded, the security upgrade is included, and the public GoDaddy button still opens an explicitly labeled preview.

## 2. Publish and qualify the corrected package

- [ ] Choose the next unused release version, update root and application package versions, and tag the reviewed commit. Follow [release publication](software-updates.md#release-publication).
- [ ] Run **Publish Open Whiteboard release** with that existing tag. Start with `prerelease: true`; set `security` only for a reviewed security fix. Require the Cloudflare, Node and manifest jobs to pass.
- [ ] Record the release URL, commit, `open-whiteboard-node.zip` SHA-256 and manifest. Download the published ZIP and verify its checksum. Test these exact bytes, not a locally rebuilt candidate.
- [ ] Deploy the ZIP to a disposable GoDaddy app using the documented API/CLI or manual procedure. Require terminal deployment status `COMPLETED`, a working published HTTPS address and `/healthz` returning 200 with `ready: true`.
- [ ] Complete owner creation and MFA. Test sign-in, creating/editing/reloading boards, images, two-user collaboration, WebSockets and an app restart with data retained. Confirm Preview and Publish data isolation and that the plan supports the required single-process replacement behavior.

Done when: the exact published package passes all live checks and evidence is recorded. Only then promote that release to stable; keep its tag and assets unchanged.

## 3. Prove updates and recovery on real hosting

- [ ] Seed the qualified test app with accounts, boards, uploads and saved settings. Take a coordinated backup of its private SQLite catalog and MySQL data, including installation keys. Restore into an isolated test installation and verify sign-in and data. Keep backup locations and credentials private.
- [x] Verify the live `GET /apps/{appId}` identity contract and current handler. On October 17, 2026, top-level `id` matched the requested app and `appType` was `NODEJS`; both test suites share the redacted response fixture. The handler connected using the provider origin and a simulated custom origin, and rejected a different configured app ID and Preview. [Evidence](qa/godaddy-application-identity.json); all provider calls were read-only.
- [ ] Exercise this same identity check on the qualified installed package at an actually attached custom domain, then complete the update tests below. The local handler test used a simulated custom origin and does not qualify custom-domain hosting or a live upgrade.
- [ ] Connect the separate four-scope update token in **Administration → Updates**. Test owner-initiated installation of a second reviewed, compatible stable patch release. Keep the same app, origin, namespaces, database and installation keys.
- [ ] Verify the replacement runs the target version, commit and schema; the provider deployment is complete; the saved update shows success; and existing accounts, boards, images and settings remain intact.
- [ ] Rehearse an interrupted request and token replacement. Continue must recover the same saved operation without creating a second app or duplicate publication.
- [ ] Test the opted-in automatic security-patch path with no browser open, using a genuinely eligible, reviewed security release in the same major/minor series. Do not mark a harmless test release as a security fix to trigger public installations. If no eligible release is available, record this check as outstanding rather than claiming unattended updates are qualified.

Done when: both source and target release identities, backup/restore results, automatic-update result and recovery evidence are recorded. A candidate replacement or a simulator run alone does not complete this step.

## 4. Deploy the separate installer and activate alerts

The marketing website is static. The credential-handling installer is a separate service; this launch uses the supplied Cloudflare Worker.

- [ ] Choose its real HTTPS address. Provision D1 for `tools/godaddy-deploy/wrangler.jsonc`, bind the actual database, and apply **all** SQL migrations in `tools/godaddy-deploy/migrations/` in order.
- [ ] Configure the `EMAIL`, `INSTALLER_LIMIT` and `INSTALLER_GLOBAL_LIMIT` bindings and the five-minute scheduled trigger. Keep request logging disabled.
- [ ] Configure `ALERT_TO` and `ALERT_FROM` as private Worker secrets using the agreed operator recipient and verified sending domain. Restrict the email destination through private deployment configuration. Never commit those addresses or credentials.
- [ ] Deploy the installer with its release gate still closed. Send a harmless test email and confirm receipt in the intended inbox before setting `ALERT_DELIVERY_VERIFIED=true`. Local `.dev.vars` values are not deployed automatically.
- [ ] Require the hosted installer's `/healthz` to return 200 with `ready: true` after a scheduled run. Exercise a controlled incident, digest delivery, successful recovery and recurrence. Verify emails contain only the documented diagnostic fields.
- [ ] Configure an independent uptime monitor for that `/healthz` endpoint with an alert route that does not depend on the installer's own email service. Test both outage notification and recovery.

Done when: the service URL, applied migrations, inbox receipt and independent monitor test are recorded privately where appropriate. A successful send API response is not proof of inbox receipt. The public site still links to the preview.

## 5. Enable and test the complete hosted setup

- [ ] Update `tools/godaddy-deploy/release.json` to the qualified stable version, exact ZIP URL and SHA-256. Update `tools/godaddy-deploy/public/agent-prompt.txt` to the same package. Set `qualified: true` only after steps 2 and 3 pass.
- [ ] Run `pnpm test:godaddy-installer`, `pnpm test:godaddy-installer:browser` and the installer Worker dry run. Review and deploy this installer configuration change.
- [ ] From a fresh browser, use the actual hosted installer URL to create a disposable app with the exact nine documented Hosting permissions. Finish owner/MFA setup and connect updates. Verify the deployment result, app health, credentials cleared after setup and no duplicate app after a recoverable interruption.
- [ ] Exercise the copyable coding-agent instructions separately with a fresh temporary credential or GoDaddy sign-in. Confirm they deploy the same qualified package. Keep credentials out of chat and logs; revoke temporary setup tokens afterward. Agent/manual deployments do not send central installer alerts.

Done when: a new person can complete real setup from the hosted page and the agent instructions without undocumented settings. Record the package and installer commit used.

## 6. Switch the public website to live setup

- [ ] Set `VITE_GODADDY_INSTALLER_URL` to the tested HTTPS installer URL in the marketing site's production build environment. It must contain no credentials, query string or fragment.
- [ ] Update the website's product submodule to include the final installer assets and instructions. Run `npm run test:config` and `npm run build:cloudflare`, then deploy the website. Changing the environment variable alone does not update an existing static bundle.
- [ ] On `https://openwhiteboard.app/`, check both provider buttons in the hero, hosting and closing sections. The GoDaddy buttons must open real setup; the dedicated walkthrough must remain clearly labeled as a preview. Check mobile layout and the Cloudflare destination too.

Done when: the public site points at the exact tested installer, and the recipient can receive failure alerts and independent outage alerts. Only now announce that GoDaddy deployment is ready to share.

## Evidence and handoff

| Item | Evidence/status |
| --- | --- |
| Product and website merge commits | Product pending; preview site merged as `80b3e1d9c8c0ff68840fbb68730c41e14a3c9a25`; final product pointer pending |
| Security advisory resolution | Pending |
| Qualified stable package/tag/commit/SHA-256 | Pending |
| Fresh live install and restart | Pending |
| Source → target stable update and unattended security update | Pending |
| Backup/restore and interrupted-update recovery | Pending |
| Hosted installer URL and deployed commit | Pending |
| D1 migrations and email receipt | Pending; private operator settings stay private |
| Independent outage/recovery notification | Pending |
| Hosted browser setup and agent setup | Pending |
| Public website build and button checks | Pending |

If a launch check fails, leave the website on preview. If a serious problem appears after launch, remove `VITE_GODADDY_INSTALLER_URL` and rebuild the site; deploy `qualified: false` on the installer to stop new installations through its direct URL too. Preserve existing installation data and saved operations. Investigate before changing a release pin or asking an affected person to start another app.

Technical references: [installer operations and alerts](../tools/godaddy-deploy/README.md), [GoDaddy hosting and backup constraints](godaddy-nodejs-installation.md), [updates](software-updates.md), and [existing qualification evidence](end-to-end-qa.md).
