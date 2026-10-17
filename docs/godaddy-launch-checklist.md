# GoDaddy public launch checklist

Merging the implementation PRs does not enable live GoDaddy installation. This is the remaining launch checklist. Leave every item unchecked until its evidence is recorded below. The owner of this work is the maintainer running the release with their coding agent; merging a PR does not transfer these tasks to an automatic workflow.

Current state: the website opens a preview and the installer still pins v0.4.0 with `qualified: false`. The separate installer Worker and D1 database are deployed, and the operator confirmed receipt of the direct email test. Scheduled incident delivery, recovery and recurrence passed at the service level. Receipt of the scheduled failure digest is confirmed; independent GitHub email remains unconfirmed. The exact v0.4.1 prerelease has passed fresh installation and restart checks; update and recovery qualification remains open.

## 1. Merge the reviewed code

- [x] Product PR #20 merged on October 17, 2026 as `cb9472d97ca9a2e101087704c95a6abf11e65ed7` after its checks passed.
- [x] Merge the preview website: [website PR #3](https://github.com/sportwhiz/huddle-loom-site/pull/3) merged on October 17, 2026 as `80b3e1d9c8c0ff68840fbb68730c41e14a3c9a25`; its Cloudflare build passed. The public GoDaddy link still opens the preview.
- [x] Website PR #4 merged as `fa1e649bbaa934f752e4079ddc01217f7a0de374`, pinning product `cb9472d97ca9a2e101087704c95a6abf11e65ed7`. Its Cloudflare production build passed.
- [x] Keep `VITE_GODADDY_INSTALLER_URL` unset. The website may publish its preview at this point; live setup remains closed.
- [x] [Product PR #24](https://github.com/sportwhiz/open-whiteboard/pull/24) merged as `22f197cf160b321fbb1aa946336c0bfc15f2db27` after all checks passed. It patches the MCP SDK, KaTeX, source-map-js and Sharp, and refreshes the bundled notices. The dependency audit and GitHub advisory list both report zero open vulnerabilities.

Done when: the merged commits and passing checks are recorded, the security upgrade is included, and the public GoDaddy button still opens an explicitly labeled preview.

## 2. Publish and qualify the corrected package

- [x] Tag `v0.4.1` points to reviewed commit `66c7ace460ff50f6484e3056a0fef720091d894a`; both package versions match. The tag was corrected before publication to include regenerated license notices.
- [x] [Release workflow 39057713431](https://github.com/sportwhiz/open-whiteboard/actions/runs/39057713431) passed its Cloudflare, Node, manifest and publication jobs. It published `v0.4.1` as a prerelease with genuine dependency security fixes.
- [x] Downloaded the [published v0.4.1 package](https://github.com/sportwhiz/open-whiteboard/releases/tag/v0.4.1). ZIP SHA-256: `347944203cd01b72b835e279dfe7661743c1a1940f8f8a1ff0c130f688dec59b`. Its embedded version, commit, schema and protocol match the release manifest; patched dependency notices are included.
- [x] Deployed the exact published v0.4.1 ZIP through the installer API and flow modules to a disposable GoDaddy Deluxe app. Deployment reached `COMPLETED`; published HTTPS health returned 200 with `ready: true`. A deliberately lost publish response resumed the original deployment with the same retry key. [Live evidence](qa/godaddy-release-v0.4.1.json).
- [x] Completed owner creation, MFA, browser sign-in, board saves, Command-D duplication, sticky editing, dragging, zooming, guest collaboration/authorization, WebSockets, images and OAuth/MCP on the published release. Provider-confirmed restarts retained owner and guest sessions, settings, board data, keys and image bytes.
- [ ] Confirm actual Preview and Publish data isolation and single-process replacement during a package update. Investigate the background asset-reconciliation retry observed after a restart.

Done when: the exact published package passes all live checks and evidence is recorded. Only then promote that release to stable; keep its tag and assets unchanged.

## 3. Prove updates and recovery on real hosting

- [x] Took an encrypted coordinated backup of the qualified v0.4.1 app’s private SQLite catalog, seven MySQL tables and installation keys. Restored into a separate empty GoDaddy app, republished the unchanged official ZIP, and verified existing sessions, fresh password sign-in, MFA, settings, matching board content/document epoch and exact image bytes. The original app remained intact. Removed temporary recovery secrets from both apps. [Evidence](qa/godaddy-full-recovery.json); [maintainer recovery tool](../tools/node-recovery/README.md).
- [x] Verify the live `GET /apps/{appId}` identity contract and current handler. On October 17, 2026, top-level `id` matched the requested app and `appType` was `NODEJS`; both test suites share the redacted response fixture. The handler connected using the provider origin and a simulated custom origin, and rejected a different configured app ID and Preview. [Evidence](qa/godaddy-application-identity.json); all provider calls were read-only.
- [ ] Exercise this same identity check on the qualified installed package at an actually attached custom domain, then complete the update tests below. The local handler test used a simulated custom origin and does not qualify custom-domain hosting or a live upgrade.
- [ ] Connect the separate four-scope update token in **Administration → Updates**. Test owner-initiated installation of a second reviewed, compatible stable patch release. Keep the same app, origin, namespaces, database and installation keys.
- [ ] Verify the replacement runs the target version, commit and schema; the provider deployment is complete; the saved update shows success; and existing accounts, boards, images and settings remain intact.
- [ ] Rehearse an interrupted request and token replacement. Continue must recover the same saved operation without creating a second app or duplicate publication.
- [ ] Test the opted-in automatic security-patch path with no browser open, using a genuinely eligible, reviewed security release in the same major/minor series. Do not mark a harmless test release as a security fix to trigger public installations. If no eligible release is available, record this check as outstanding rather than claiming unattended updates are qualified.

Done when: both source and target release identities, backup/restore results, automatic-update result and recovery evidence are recorded. A candidate replacement or a simulator run alone does not complete this step.

## 4. Deploy the separate installer and activate alerts

The marketing website is static. The credential-handling installer is a separate service; this launch uses the supplied Cloudflare Worker.

- [x] Choose its real HTTPS address. Provision D1 for `tools/godaddy-deploy/wrangler.jsonc`, bind the actual database, and apply **all** SQL migrations in `tools/godaddy-deploy/migrations/` in order.
- [x] Configure the `EMAIL`, `INSTALLER_LIMIT` and `INSTALLER_GLOBAL_LIMIT` bindings and the five-minute scheduled trigger. Keep request logging disabled.
- [x] Configure `ALERT_TO` and `ALERT_FROM` as private Worker secrets using the agreed operator recipient and verified sending domain. Restrict the email destination through private deployment configuration. Never commit those addresses or credentials.
- [x] Deploy the installer with its release gate still closed. Send a harmless test email and confirm receipt in the intended inbox before setting `ALERT_DELIVERY_VERIFIED=true`. Local `.dev.vars` values are not deployed automatically.
- [x] Require the hosted installer's `/healthz` to return 200 with `ready: true` after a scheduled run. Exercise a controlled incident, digest delivery, successful recovery and recurrence. Verify emails contain only the documented diagnostic fields.
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
| Product and website merge commits | Product `cb9472d97ca9a2e101087704c95a6abf11e65ed7`; site `fa1e649bbaa934f752e4079ddc01217f7a0de374`; production build passed |
| Security advisory resolution | PR #24 merged; dependency audit and GitHub open-alert list are empty |
| Qualified stable package/tag/commit/SHA-256 | Published and checksum-verified v0.4.1 prerelease; live qualification and stable promotion pending |
| Fresh live install and restart | Exact published v0.4.1 passed; [sanitized evidence](qa/godaddy-release-v0.4.1.json). Preview isolation and replacement-update behavior remain pending |
| Source → target stable update and unattended security update | Pending |
| Backup/restore and interrupted-update recovery | Pending |
| Hosted installer URL and deployed commit | [Dedicated Worker](https://open-whiteboard-godaddy-installer.cool-salad-9f16.workers.dev/), deployed source `0f9b8d3e33cc6da0ec0dd432fd21080cb41667a7`, including the revised holding page; live asset verified against source. Release gate closed. [Runtime fix PR #30](https://github.com/sportwhiz/open-whiteboard/pull/30) merged with all checks passing |
| D1 migrations and email receipt | All three migrations applied; direct Cloudflare test received and confirmed October 17, 2026. Private recipient, sender and deployment configuration remain outside Git. Two real scheduled runs accepted the controlled incident and its recurrence; recovery and repeat suppression passed. The operator also confirmed receipt of the scheduled failure digest. [Hosted evidence](qa/godaddy-hosted-installer.json) |
| Independent outage/recovery notification | PR #25 merged as `086a873e9e04214e4bcfeb9e02173f3963f5ee71`; [outage exercise](https://github.com/sportwhiz/open-whiteboard/actions/runs/39058451586) opened test issue #26 and [recovery exercise](https://github.com/sportwhiz/open-whiteboard/actions/runs/39058482686) closed it. The live schedule is enabled. [Live endpoint check](https://github.com/sportwhiz/open-whiteboard/actions/runs/39061843197) and [second recovery exercise](https://github.com/sportwhiz/open-whiteboard/actions/runs/39061841165) passed; test issue #29 is closed. GitHub inbox delivery remains unconfirmed |
| Hosted browser setup and agent setup | Pending |
| Public website build and button checks | Pending |

If a launch check fails, leave the website on preview. If a serious problem appears after launch, remove `VITE_GODADDY_INSTALLER_URL` and rebuild the site; deploy `qualified: false` on the installer to stop new installations through its direct URL too. Preserve existing installation data and saved operations. Investigate before changing a release pin or asking an affected person to start another app.

Technical references: [installer operations and alerts](../tools/godaddy-deploy/README.md), [GoDaddy hosting and backup constraints](godaddy-nodejs-installation.md), [updates](software-updates.md), and [existing qualification evidence](end-to-end-qa.md).
