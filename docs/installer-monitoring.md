# Installer uptime alerts

The public Open Whiteboard repository checks the hosted installer's `/healthz` endpoint every ten minutes through GitHub Actions. GitHub schedules can be delayed; this is an independent periodic check, not a guaranteed response-time service.

After three failed probes, the workflow opens one issue assigned to the repository owner. It leaves an ongoing incident quiet and closes the issue when the service recovers. A later outage opens a new issue. GitHub notifications provide a separate alert route from the installer's Cloudflare email service.

Before activation, set repository variable `GODADDY_INSTALLER_HEALTH_URL` to the real HTTPS `/healthz` address and `GODADDY_INSTALLER_MONITOR_ENABLED` to `true`. The monitor needs no GoDaddy token, Cloudflare credential or email address. It never sends its GitHub credential to the health endpoint.

The owner must enable email notifications for assigned or mentioned issues in this repository and use their intended notification email address in GitHub settings. Run **Installer uptime** manually with `exercise: outage`, confirm the email arrives, then run `exercise: recovery` and confirm the recovery notification. Test issues are separate from real incidents. A successful workflow alone does not confirm inbox delivery.

Review failed monitor workflows too: a GitHub permission failure or workflow error must not be mistaken for a healthy installer. GitHub's own availability and the recipient's notification preferences affect this alert route.

Alerts contain only fixed health categories and links to monitor runs. They do not identify individual installations or expose operator email addresses.

Run `node --test scripts/installer-uptime.test.mjs` before changing the monitor. Keep private operator details out of committed files.
