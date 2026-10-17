# Deploy to GoDaddy installer

A browser flow for deploying a new Open Whiteboard installation to GoDaddy Node.js Hosting. It creates the app, attaches an existing hosting plan, sets the published address and setup passphrase, uploads the qualified Node release, publishes it, and waits for successful GoDaddy deployment completion, reads runtime status, and checks `/healthz` before handing off to administrator setup.

The remaining public rollout is tracked in the [GoDaddy launch checklist](../../docs/godaddy-launch-checklist.md). Merging the code does not complete that checklist.

## Run locally

Requires Node 22.16 or later. No installer dependencies or build step are needed:

```sh
pnpm deploy:godaddy
```

Open `http://127.0.0.1:5305`. Enter a GoDaddy personal access token, select a plan with capacity, and choose a name and private setup passphrase. The installer creates a **new** app. After first-owner setup, **Administration → Updates** connects a separate update token and offers automatic compatible security patches. The installer never retains its temporary token for this.

For deployment, select `hosting.application:create`, `hosting.application:read`, `hosting.source:read`, `hosting.source:write`, `hosting.deployment:execute`, `hosting.secret:write`, `hosting.subscription:read`, and `hosting.subscription:write`. The setup checklist also includes `hosting.log:read` so a coding assistant can diagnose startup failures without replacing the token. The browser installer does not fetch or email raw logs. It does not need shopping, domain, GitHub-connection, secret-reading, application-update, or deletion permissions. A classic GoDaddy domain API key/secret is not a personal access token.

## Permission audit

Checked against [GoDaddy’s scope reference](https://developer.godaddy.com/en/docs/api-users/hosting/concepts#scopes-reference) and [log-reading guide](https://developer.godaddy.com/en/docs/api-users/hosting/read-logs) on October 17, 2026. The setup page, downloadable agent instructions, and this guide list the same nine scopes. The page follows the token picker’s six sections: Applications (read, create, deployment-execute), Source Code (read, write), Domains (none), Secrets (write), Subscriptions (read, write), and Logs (read). This grouping was confirmed against the token-picker text supplied by the user. GitHub-connection access is unnecessary for a ZIP upload.

| Permission | Use |
| --- | --- |
| `hosting.application:create` | Create the new Node.js app. |
| `hosting.application:read` | Read app addresses, creation progress, deployment progress, and runtime status. |
| `hosting.source:write` | Upload the verified release ZIP. |
| `hosting.source:read` | Check source import progress. |
| `hosting.deployment:execute` | Publish the app. |
| `hosting.secret:write` | Set the app address, setup passphrase, and runtime settings in each variant. |
| `hosting.subscription:read` | List existing hosting plans and available app slots. |
| `hosting.subscription:write` | Attach the selected existing plan. |
| `hosting.log:read` | Let the coding assistant inspect startup logs if troubleshooting is needed. |

GoDaddy documents that a write scope also permits reads of the same resource. We list source-read and subscription-read explicitly so people can match the operations to the scope picker.

The separate update token uses application-read, source-read, source-write, and deployment-execute. Updates do not read logs or change secrets, plan assignments, or app metadata. Manual custom-domain setup is outside this installer and may need domain permissions if performed through the API.

Connecting a token checks access to hosting plans; it does not prove every permission is present. The Hosting API contract does not expose token-scope introspection. Do not test write permissions by creating throwaway apps or changing settings. A later 401/403 can still require a replacement token with this complete checklist. Log access is for local troubleshooting and does not enable maintainer failure-alert emails by itself.

## Host the button destination

The standalone Node server can run behind an HTTPS proxy with `HOST=0.0.0.0`, the host-assigned `PORT`, and `LAUNCHER_ORIGIN` set to its exact public HTTPS origin. Package only `api.mjs`, `monitoring.mjs`, `server.mjs`, `release.json`, `package.json`, `package-lock.json`, and `public/`. Never include a `.env`, credentials, test fixture, or local setup record. GoDaddy itself can host this installer using the same API contract.

A Cloudflare Worker entry is also included:

```sh
pnpm exec wrangler deploy --dry-run --config tools/godaddy-deploy/wrangler.jsonc
# When publishing is authorized:
pnpm exec wrangler deploy --config tools/godaddy-deploy/wrangler.jsonc
```

Point the repository’s **Deploy to GoDaddy** button at the actual verified HTTPS installer URL after publication. Do not use a placeholder destination. No provider token is configured on the server: each person supplies their own for their deployment.

The service receives sensitive credentials. Keep request-body/header logging, analytics, third-party scripts, session recording, and error-payload capture disabled. The supplied server does not log requests; the Worker configuration disables observability. Rate-limit a public deployment at its hosting edge without recording credentials.

## Release and recovery behavior

`release.json` pins the official `sportwhiz/open-whiteboard` Node release and SHA-256 digest. Downloads are checked before creating an app or uploading source. `qualified: false` currently blocks deployments because the pinned v0.4.0 ZIP failed GoDaddy’s supervisor health check. Advance the version, URL, checksum, and agent prompt together after publishing a release with the loopback readiness fix; set `qualified: true` only after real GoDaddy qualification. The candidate build has passed live publication, but is not a published release. Changes in the working tree are not part of a previously published release.

Each asynchronous write uses a stable idempotency key, including a stable multipart boundary for ZIP upload. Continue resumes completed steps and polls known operation IDs; it does not create a replacement app on a timeout. Request errors and provider logs are never forwarded verbatim. A failed provider job needs diagnosis in the GoDaddy dashboard; Continue checks that same job rather than blindly reuploading. Sessions expire before GoDaddy’s 24-hour idempotency retention window.

Keep the page open. Recovery state and credentials exist only in browser memory, and a navigation warning guards an active deployment. Closing the page loses automatic recovery; find the displayed app ID in GoDaddy before starting another installation. Apps and plan assignments are not automatically deleted after failures.

## Preview and production

The live `AUTH_ORIGIN` comes from the authenticated Hosting API’s `urls.publish` value. New live installations use `HUDDLE_DATABASE_NAMESPACE=live`; Preview gets `preview`. The platform, setup passphrase, namespace, app ID, and variant are set before source upload. The latter two allow update setup to identify its app without asking people to find a technical identifier, and keep Preview out of the production updater.

GoDaddy currently returns a **dashboard wrapper** at `urls.preview`, such as `https://host.godaddy.com/nodejs/projects/<id>/preview`. This is not the app’s origin. For this response, the installer leaves Preview on Open Whiteboard’s configuration guide and does not set Preview’s `AUTH_ORIGIN`. Preview does not open the database before configuration. Production is fully configured and published. To use Preview interactively later, follow the guide inside its dashboard and set its actual app origin. If GoDaddy supplies an actual HTTPS origin in the future, the installer accepts and configures it.

The readiness proxy accepts only the provider-returned, generated `*.c<number>.airoapp.ai` live host, rejects redirects, and sends no GoDaddy credential to app code. Custom-domain changes and existing installation upgrades are outside this new-install flow.

## Verify

```sh
pnpm test:godaddy-installer
pnpm test:godaddy-installer:browser
```

Install Playwright Chromium first, or set `CHROME_PATH` to an existing Chrome executable. The browser test runs the real UI and API handler against an isolated provider simulator; it does not create real accounts or apps. It covers invalid tokens, plan capacity, disconnect, lost creation responses, safe continuation, full deployment, cleared credentials, and desktop/mobile layouts. Unit/integration tests cover API shapes, per-variant settings, checksums, errors, path validation, redirect policy, and readiness.

The guided page also includes exact seven-day token creation/revocation instructions, a generated setup passphrase option, and a copy/download prompt for Claude, Codex, or another coding agent. The agent prompt prefers GoDaddy browser sign-in and contains no credential.

Live qualification must separately verify the published host, owner/MFA setup, editor, collaboration, WebSockets, persistence, and update behavior. A successful provider API job alone does not prove those work. Conversely, a briefly healthy app does not prove the deployment will succeed: GoDaddy can roll it back after a supervisor probe fails. Never skip terminal deployment status based on an early HTTP response. The live API may report only Preview in runtime status while publishing; the completed job plus the published app’s health check are the required gates.

## API references

- [Deploy a Node.js app](https://developer.godaddy.com/en/docs/api-users/hosting/workflows/deploy-nodejs-app)
- [API schema](https://developer.godaddy.com/openapi/hosting.json)
- [Secrets and variants](https://developer.godaddy.com/en/docs/api-users/hosting/manage-secrets)
- [Hosting troubleshooting](https://developer.godaddy.com/en/docs/api-users/troubleshoot/hosting)
- [CLI deployment walkthrough](https://www.godaddy.com/resources/news/deploy-a-node-js-app-to-godaddy-from-your-terminal-or-let-your-coding-agent-do-it)

## Interactive site walkthrough

Append `?preview=1` to walk through these exact installer screens with example values. `preview.js` handles the simulated steps entirely in browser memory; it never calls the API. Credential fields are read-only examples, completion is labeled as a preview, and the final screen explains owner setup and the separate update connection. The marketing site copies only the public assets into `/deploy/godaddy/` and marks its HTML `data-preview-only="true"`, so removing the query string cannot enable real deployment there. The live launcher still enforces release qualification when preview is off.

### Visual assets

The installer uses Open Whiteboard’s Source Sans 3 font and brand mark. The GoDaddy GO mark comes from [GoDaddy’s developer site](https://developer.godaddy.com/images/icons/godaddy-heart-white.svg). Its original white artwork and a black fill variant identify the hosting provider. The shape and transparent background are preserved. GoDaddy retains its trademark rights.

## Maintainer failure alerts

The Cloudflare installer has a D1 incident queue and a five-minute email scheduler. It records a random browser-attempt reference, failed action, fixed error category, pinned release version, and timestamps. It never stores or emails tokens, setup passphrases, app/account identifiers, request bodies, raw provider errors, or logs. The setup page discloses reporting before requesting a token. Records expire after 30 days without activity. Detailed reports and browser timeouts require an attempt with a successful GoDaddy API response in the last 24 hours. Before that, upstream failures contribute only to fixed category counters. Browser reports with unknown references are discarded. The registry holds at most 1,000 attempts and the queue at most 5,000 incident records; each attempt/action has one row. Capacity failures contribute to a separate aggregate counter in the digest so the maintainer can see that detailed reporting needs attention. Apply both D1 migrations before deploying the Worker.

Failures that recover before the five-minute grace period do not send mail. Repeated failures for the same attempt/action share one record. A failure that returns after resolution gets a new grace period and can alert again. Digests include the total pending count and up to 50 records, prioritizing API failures over browser timeouts, with at most one successful digest per hour. Failed sends remain pending for retry. A send accepted by the provider is not proof of inbox delivery; an ambiguous acknowledgement can cause a duplicate with the same support references. A browser timeout is labeled as browser-reported, separately from an API failure. The UI only says a failure was recorded after storage succeeds; it never claims an email was delivered.

The production Worker blocks new connections and app creation when reporting configuration, recent scheduler activity, or email delivery is unhealthy. Recovery operations for an existing app remain available. Two rate-limit bindings allow 120 API requests per caller per minute and 1,200 overall per minute at each Cloudflare location. Caller keys are daily hashes of the Cloudflare-provided network address; neither the address nor the hash is stored in diagnostics or logs. A throttled caller does not consume the global allowance. This is not an account-wide traffic or D1 cost ceiling. Monitor provider usage and increase the budget only after checking normal demand. Request logging remains disabled.

If email fails and the queued installation errors resolve before delivery recovers, the scheduler sends a delivery check to the configured operator address. Failed checks retry at five-minute intervals; one accepted check clears the failure state and ends the probes. Resolved installation errors are not included in that message. The scheduler lease and hourly successful-send limit still apply.

Private operator settings, supplied as Worker secrets:

- `ALERT_TO`: the maintainer's destination email address.
- `ALERT_FROM`: a sending address on an onboarded Cloudflare Email Service domain.
- `ALERT_DELIVERY_VERIFIED`: set to `true` only after a test message arrives in the intended inbox.

Do not put these addresses in checked-in configuration or frontend assets. `.dev.vars` is ignored and is for local operator configuration only; Wrangler does not deploy its values automatically. The unrestricted `EMAIL` binding still requires a verified destination in Cloudflare. Restrict it to the operator recipient through private deployment configuration when activating production.

Activation requires Cloudflare account access, an onboarded sending domain, verified recipient, a deployed Worker and D1 database with all SQL files in `migrations/` applied in order. Send a harmless test email using Cloudflare Email Service, confirm inbox delivery, configure the secrets, then wait for the first scheduled run and require `/healthz` to return 200 with `ready: true`. Exercise a synthetic incident and its recovery on the hosted Worker before sharing the installer. Keep the release gate closed until the package is also qualified.

An independent uptime monitor must watch the hosted installer's `/healthz`. The installer cannot email about a total Cloudflare outage or a mail delivery problem when that same mail service is unavailable. No public installer or external uptime monitor is activated by these source changes. Monitoring `/healthz` does not qualify the release or prove future inbox delivery.

The standalone Node launcher has no central monitoring adapter by default, and the browser-only walkthrough makes no reporting calls. Manual ZIP deployments and coding-agent runs are outside the hosted installer's reporting coverage.
