import { useState } from "react";
import { api } from "../auth-client";
import { Field, Feedback, useAction } from "../auth-ui";
import type { UpdateStatus } from "./UpdatesPanel";
const labels: Record<string, string> = {
  queued: "Update scheduled",
  building: "Preparing the update",
  deploying: "Publishing to GoDaddy",
  verifying: "Checking the new version",
  succeeded: "Installed",
  failed: "Needs attention",
  uncertain: "Needs your help",
};
export function GoDaddyUpdatesPanel({
  data,
  error,
  reload,
  owner,
}: {
  data: UpdateStatus;
  error: string;
  reload: () => Promise<void>;
  owner: boolean;
}) {
  const action = useAction(reload);
  const [token, setToken] = useState("");
  const [appId, setAppId] = useState(data.appId ?? "");
  const [connecting, setConnecting] = useState(false);
  const [pendingPreference, setPendingPreference] = useState<boolean>();
  const [confirmedStopped, setConfirmedStopped] = useState(false);
  const active = data.history.find(
    (row) => !["succeeded", "failed"].includes(row.status),
  );
  return (
    <div className="updates-panel">
      <header className="updates-heading">
        <span className="identity-tag">CARE FOR YOUR STUDIO</span>
        <h1>Studio updates</h1>
        <p>Keep your whiteboard up to date without uploading files.</p>
      </header>
      <Feedback error={error} />
      {action.feedback}
      <section className="identity-section updates-release">
        <h2>Version {data.current.version}</h2>
        <p>
          {data.connected
            ? "GoDaddy updates connected"
            : "Connect GoDaddy once to update from here."}
        </p>
        {owner && (
          <div className="identity-actions">
            <button
              disabled={action.busy || !!active}
              onClick={() =>
                void action.run(
                  () => api("/api/v1/admin/updates/check", {}),
                  "Checked for updates.",
                )
              }
            >
              Check for updates
            </button>
            <button
              disabled={action.busy}
              onClick={() => setConnecting(!connecting)}
            >
              {data.connected ? "Replace update token" : "Connect updates"}
            </button>
          </div>
        )}
        {data.checkError && <Feedback error={data.checkError} />}
        {data.checkedAt && (
          <small>
            Last checked {new Date(data.checkedAt).toLocaleString()}
          </small>
        )}
      </section>
      {owner && connecting && (
        <section className="identity-section">
          <h2>Connect automatic updates</h2>
          <p>
            Your setup token was temporary. Create a separate token for updates;
            it stays encrypted inside this whiteboard.
          </p>
          <ol>
            <li>
              Open{" "}
              <a
                href="https://developer.godaddy.com/personal-access-token"
                target="_blank"
                rel="noreferrer noopener"
              >
                GoDaddy’s token page
              </a>{" "}
              and choose <strong>Generate Token</strong>.
            </li>
            <li>
              Name it <strong>Open Whiteboard updates</strong>. Choose an expiry
              you are comfortable with (up to one year).
            </li>
            <li>
              Select only these permissions:{" "}
              <code>hosting.application:read</code>,{" "}
              <code>hosting.source:read</code>,{" "}
              <code>hosting.source:write</code>, and{" "}
              <code>hosting.deployment:execute</code>.
            </li>
            <li>
              Choose <strong>Create Token</strong>, copy it, and paste it below.
            </li>
          </ol>
          <p>
            These permissions can access other apps in your GoDaddy account.
            This whiteboard checks its own app and address before connecting. It
            never uses the token to buy a plan or change your database settings.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const submitted = token.trim();
              setToken("");
              void action.run(async () => {
                await api("/api/v1/admin/updates/connection", {
                  appId,
                  token: submitted,
                });
                setConnecting(false);
              }, "Updates connected.");
            }}
          >
            {!data.appId && (
              <Field
                label="GoDaddy app ID"
                name="godaddy-app"
                value={appId}
                onChange={setAppId}
                hint="For an older installation, copy the NODEJS-… identifier from your GoDaddy app details."
              />
            )}
            <Field
              label="Update token"
              name="godaddy-update-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={setToken}
            />
            <div className="identity-actions">
              <button disabled={action.busy || !token.trim()} type="submit">
                Connect updates
              </button>
              <button
                type="button"
                onClick={() => {
                  setToken("");
                  setConnecting(false);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
          <p>
            When the token expires or is revoked, updates pause and this page
            explains how to reconnect. Your whiteboard keeps working.
          </p>
        </section>
      )}
      <section className="identity-section">
        <h2>Automatic security updates</h2>
        <p>
          Check daily and install compatible security patches automatically. New
          features wait for you to choose Update now. Changes that need a
          database upgrade use the guided upgrade process.
        </p>
        <label className="identity-check">
          <input
            type="checkbox"
            checked={pendingPreference ?? data.automaticSecurity}
            disabled={!owner || action.busy || !data.connected}
            onChange={(event) => {
              const automaticSecurity = event.target.checked;
              setPendingPreference(automaticSecurity);
              void action
                .run(() =>
                  api("/api/v1/admin/updates/policy", { automaticSecurity }),
                )
                .finally(() => setPendingPreference(undefined));
            }}
          />{" "}
          Install compatible security patches automatically
        </label>
        <p>People on open boards may briefly reconnect during an update.</p>
        <p>If an update cannot start, this page will also be unavailable. Recovery
          currently requires republishing the previous package from GoDaddy.
          Keep a working package and a current backup before enabling unattended updates.</p>
        {owner && data.connected && (
          <button
            disabled={action.busy || !!active}
            onClick={() =>
              void action.run(
                () =>
                  api("/api/v1/admin/updates/connection", { disconnect: true }),
                "Updates disconnected. You can now revoke the update token in GoDaddy.",
              )
            }
          >
            Disconnect updates
          </button>
        )}
      </section>
      {data.available && data.updateAvailable && (
        <section className="identity-section">
          <h2>Version {data.available.version} is available</h2>
          <p>{data.available.notes}</p>
          {data.incompatibility && (
            <p>
              {data.incompatibility}{" "}
              <a
                href="https://github.com/sportwhiz/open-whiteboard/blob/main/docs/godaddy-nodejs-installation.md#update-an-existing-app"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open the upgrade guide
              </a>
            </p>
          )}
          {owner && (
            <button
              disabled={
                action.busy ||
                !data.connected ||
                !!active ||
                !!data.incompatibility
              }
              onClick={() =>
                void action.run(
                  () =>
                    api("/api/v1/admin/updates/install", {
                      version: data.available!.version,
                    }),
                  "Update started. You can leave this page; your whiteboard will continue the update.",
                )
              }
            >
              Update now
            </button>
          )}
        </section>
      )}
      {!!data.history.length && (
        <section className="identity-section">
          <h2>Update history</h2>
          <ul className="updates-history">
            {data.history.map((row) => (
              <li key={row.id}>
                <strong>
                  Version {row.version} · {labels[row.status] ?? row.status}
                </strong>
                <p>{new Date(row.created_at).toLocaleString()}</p>
                {row.message && <p>{row.message}</p>}
                {owner && row.status === "queued" && (
                  <button disabled={action.busy} onClick={() => void action.run(
                    () => api("/api/v1/admin/updates/cancel", { id: row.id }),
                    "Update cancelled. No deployment was started.",
                  )}>Cancel update</button>
                )}
                {owner && row.status === "uncertain" && (
                  <>
                    <button
                      disabled={action.busy || !data.connected}
                      onClick={() =>
                        void action.run(
                          () =>
                            api("/api/v1/admin/updates/continue", {
                              id: row.id,
                            }),
                          "Continuing the saved deployment.",
                        )
                      }
                    >
                      Continue update
                    </button>
                    <details>
                      <summary>Still stuck?</summary>
                      <p>
                        Open{" "}
                        <a
                          href="https://host.godaddy.com"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          your GoDaddy dashboard
                        </a>{" "}
                        and check this app’s deployment. Once it has finished or
                        stopped, you can close this record and start a new
                        update.
                      </p>
                      <label className="identity-check">
                        <input
                          type="checkbox"
                          checked={confirmedStopped}
                          onChange={(event) =>
                            setConfirmedStopped(event.target.checked)
                          }
                        />{" "}
                        I checked GoDaddy: the deployment is finished or
                        stopped.
                      </label>
                      <button
                        disabled={action.busy || !confirmedStopped}
                        onClick={() =>
                          void action.run(async () => {
                            await api("/api/v1/admin/updates/resolve", {
                              id: row.id,
                              confirmedStopped: true,
                            });
                            setConfirmedStopped(false);
                          }, "Deployment record closed.")
                        }
                      >
                        Close this update record
                      </button>
                    </details>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!owner && <p>Your Studio owner manages update settings.</p>}
    </div>
  );
}
