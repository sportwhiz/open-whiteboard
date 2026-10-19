import { useFindSetting } from "./useFindSetting";
import { UpdatesPanel } from "./admin/UpdatesPanel";
import { MarkerColorField } from "./MarkerColorField";
import { securityEventLabel } from "./security-event-label";
import { openTour } from "./onboarding-events";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { matchSettingsRoutes, matchSettingTargets, SETTING_TARGETS, type SettingTarget } from "./settings-search";
import { requestNavigation } from "./admin/FormSaveBar";
import { UiIcon, type UiIconName } from "./UiIcon";
import { ThemeMenu } from "./theme";
import {
  api,
  authSnapshot,
  bootstrapAuth,
  returnPath,
  type AuthBootstrap,
} from "./auth-client";
import {
  Brand,
  Field,
  Feedback,
  passkeyAction,
  StepUp,
  useAction,
} from "./auth-ui";
import { FactorEnrollment } from "./AuthPage";
import { AdminPanel } from "./admin/AdminPanel";
import "./auth.css";

type Security = {
  user: { id: string; name: string; email: string; color: string };
  role: string | null;
  status: string;
  verified: boolean;
  localUsername?: string;
  emailVerified?: boolean;
  twoFactorEnabled: boolean;
  recoveryRequired: boolean;
  methods: { id: string; providerId: string }[];
  passkeys: {
    id: string;
    name: string;
    deviceType: string;
    backedUp: boolean;
    createdAt: string;
  }[];
  sessions: {
    id: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    userAgent: string | null;
    current: boolean;
  }[];
  events: { id: string; action: string; outcome: string; created_at: string }[];
};
const routes: {
  path: string;
  label: string;
  icon: UiIconName;
  admin?: boolean;
  owner?: boolean;
  /** Words people search for that are not in the title. */
  keywords?: string;
}[] = [
  { path: "/settings/account", label: "Account and security", icon: "lock", keywords: "profile name email password passkeys mfa two-factor 2fa authenticator recovery codes devices sessions sign out security" },
  { path: "/settings/connections", label: "Connected apps", icon: "apps", keywords: "mcp chatgpt claude oauth integrations api access tokens connectors" },
  { path: "/settings/people", label: "People", icon: "people", admin: true, keywords: "users members accounts invite approve suspend roles admins permissions bulk" },
  {
    path: "/settings/invitations",
    label: "Invitations",
    icon: "share",
    admin: true,
    keywords: "invite invites invitation links email pending",
  },
  {
    path: "/settings/sign-in",
    label: "Sign-in settings",
    icon: "lock",
    owner: true,
    keywords: "authentication registration password magic links email sign-in links mfa two-factor 2fa require policy sessions timeout providers github google oidc sso reauthentication verification",
  },
  {
    path: "/settings/clients",
    label: "App clients",
    icon: "apps",
    owner: true,
    keywords: "oauth clients mcp apps dynamic registration secrets",
  },
  {
    path: "/settings/usage",
    label: "Usage and limits",
    icon: "activity",
    admin: true,
    keywords: "limits quotas storage boards members guests email per day",
  },
  {
    path: "/settings/activity",
    label: "Security activity",
    icon: "history",
    admin: true,
    keywords: "audit log security events history",
  },
  { path: "/settings/updates", label: "Updates", icon: "history", admin: true, keywords: "version upgrade release software" },
  { path: "/settings/system", label: "System", icon: "settings", admin: true, keywords: "email smtp mail setup configuration migrations backups recovery jobs health" },
];
export function Settings({ section }: { section: string }) {
  const [confirming, setConfirming] = useState(
    new URLSearchParams(location.search).get("stepUp") === "true",
  );
  const [navigationQuery, setNavigationQuery] = useState("");
  const role = authSnapshot()?.account?.role;
  const available = routes.filter(
    (route) =>
      (!route.admin || ["owner", "admin"].includes(role ?? "")) &&
      (!route.owner || role === "owner"),
  );
  const active = available.find(
    (route) => route.path === `/settings/${section}`,
  );
  useEffect(() => {
    const previous = document.title;
    document.title = `${active?.label ?? "Settings"} · Open Whiteboard`;
    return () => { document.title = previous; };
  }, [active?.label]);
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      const search = searchRef.current;
      if (!search || !search.getClientRects().length) return;
      event.preventDefault();
      search.focus();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const searching = navigationQuery.trim().length > 0;
  // A search result opens its section and goes straight to the setting.
  const findHref = (path: string) => `${path}?find=${encodeURIComponent(navigationQuery.trim())}`;
  useFindSetting(".identity-content", section);
  const matchingRoutes = matchSettingsRoutes(available, navigationQuery);
  // Individual settings this person can reach, labelled by whose they are.
  const matchingSettings = matchSettingTargets(SETTING_TARGETS.filter(target => !target.path || available.some(route => route.path === target.path)), navigationQuery);
  const openSetting = (target: SettingTarget) => {
    if (target.action === "theme") {
      const summary = document.querySelector<HTMLElement>(".identity-header .theme-menu > summary");
      summary?.click();
      summary?.focus();
      return;
    }
    requestNavigation(`${target.path}?find=${encodeURIComponent(target.find)}`);
  };
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultLinks = () => Array.from(resultsRef.current?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []);
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (searching && matchingSettings[0]) openSetting(matchingSettings[0]);
      else if (searching && matchingRoutes[0]) requestNavigation(findHref(matchingRoutes[0].path));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      resultLinks()[0]?.focus();
    } else if (event.key === "Escape" && navigationQuery) {
      event.preventDefault();
      setNavigationQuery("");
    }
  };
  const onResultKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) return;
    const links = resultLinks();
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === "Escape") { searchRef.current?.focus(); return; }
    if (event.key === "ArrowUp" && index === 0) { searchRef.current?.focus(); return; }
    const next = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : event.key === "ArrowDown" ? Math.min(links.length - 1, index + 1) : index - 1;
    links[next]?.focus();
  };
  return (
    <main className="identity-settings">
      {confirming && (
        <StepUp
          onComplete={() => location.replace(returnPath())}
          onCancel={() => {
            setConfirming(false);
            const url = new URL(location.href);
            url.searchParams.delete("stepUp");
            history.replaceState(null, "", url);
          }}
        />
      )}
      <header className="identity-header">
        <Brand />
        <div className="identity-actions">
          <button onClick={() => openTour()}>Quick tour</button>
          <a className="identity-back-link" href="/" aria-label="Back to boards">
            <UiIcon name="back" />
            <span className="label-long" aria-hidden="true">Back to boards</span>
            <span className="label-short" aria-hidden="true">Boards</span>
          </a>
          <ThemeMenu />
        </div>
      </header>
      <div className="identity-layout">
        <nav className={`identity-nav ${searching ? "searching" : ""}`} aria-label="Settings">
          <label className="settings-search">
            <UiIcon name="search" />
            <input ref={searchRef} type="search" aria-label="Find settings" aria-describedby="settings-search-hint" aria-controls="settings-search-results" placeholder="Find settings" value={navigationQuery} onChange={event => setNavigationQuery(event.target.value)} onKeyDown={onSearchKey} />
            {!searching ? <kbd aria-hidden="true">/</kbd> : null}
          </label>
          <span id="settings-search-hint" className="sr-only">Search titles and topics such as password or invitations. Press Enter to open the first result, or the down arrow to move through results.</span>
          <p className="sr-only" role="status">{searching ? `${matchingRoutes.length} ${matchingRoutes.length === 1 ? "section matches" : "sections match"}` : ""}</p>
          <div id="settings-search-results" className="identity-nav-links" ref={resultsRef} onKeyDown={onResultKey}>
            {searching && !matchingRoutes.length && !matchingSettings.length ? <p className="settings-no-match">No settings match “{navigationQuery.trim()}”.</p> : null}
            {matchingSettings.map((target, index) => (
              <div key={`${target.section}:${target.label}`}>
                <a
                  href={target.action ? "#" : `${target.path}?find=${encodeURIComponent(target.find)}`}
                  className={`setting-result ${index === 0 ? "first-result" : ""}`}
                  onClick={event => { if (target.action) { event.preventDefault(); openSetting(target); } }}
                >
                  <UiIcon name={target.action === "theme" ? "sun" : target.section === "Your account" ? "lock" : "settings"} />
                  <span><small>{target.section}</small>{target.label}</span>
                  {index === 0 ? <kbd aria-hidden="true">↵</kbd> : null}
                </a>
              </div>
            ))}
            {matchingRoutes.map((route, index) => (
              <div key={route.path}>
                {!searching && (route.admin || route.owner) && !matchingRoutes.slice(0, index).some(item => item.admin || item.owner) && (
                  <div className="identity-nav-label">Administration</div>
                )}
                <a
                  href={searching ? findHref(route.path) : route.path}
                  aria-current={active?.path === route.path ? "page" : undefined}
                  className={searching && index === 0 && !matchingSettings.length ? "first-result" : undefined}
                >
                  <UiIcon name={route.icon} />
                  <span>{route.label}</span>
                  {searching && index === 0 && !matchingSettings.length ? <kbd aria-hidden="true">↵</kbd> : null}
                </a>
              </div>
            ))}
          </div>
        </nav>
        <section className="identity-content">
          <label className="identity-mobile-nav">
            {/* Phones: the picker's value names the section; keep it compact. */}
            <span className="sr-only">Settings section</span>
            <select
              aria-label="Settings section"
              value={active?.path ?? ""}
              onChange={(event) => requestNavigation(event.target.value)}
            >
              {available.map((route) => (
                <option value={route.path} key={route.path}>
                  {route.label}
                </option>
              ))}
            </select>
          </label>
          {!active ? (
            <>
              <h1>Settings unavailable</h1>
              <p>This section requires a different installation role.</p>
              <a href="/settings/account">Open your account</a>
            </>
          ) : section === "updates" ? (
            <UpdatesPanel />
          ) : section === "account" ? (
            <AccountPanel />
          ) : (
            <AdminPanel key={section} section={section} />
          )}
        </section>
      </div>
    </main>
  );
}
function Row({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="identity-row">
      <div>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </div>
      <div className="identity-actions">{children}</div>
    </div>
  );
}
function AccountPanel() {
  const [data, setData] = useState<Security>();
  const [loadError, setLoadError] = useState("");
  const [edit, setEdit] = useState<
    | "profile"
    | "email"
    | "password"
    | "authenticator"
    | "codes"
    | "delete"
    | null
  >(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#4262ff");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [codes, setCodes] = useState<string[]>();
  const [localRecoveryKey, setLocalRecoveryKey] = useState("");
  const refresh = async () => {
    const value = await api<Security>("/api/v1/account/security");
    setData(value);
    setName(value.user.name);
    setColor(value.user.color);
    await bootstrapAuth(true);
  };
  const action = useAction(refresh);
  useEffect(() => {
    void refresh().catch((failure) => setLoadError(failure.message));
  }, []);
  if (loadError)
    return (
      <>
        <h1>Account and security</h1>
        <Feedback error={loadError} />
        <button
          onClick={() => {
            setLoadError("");
            void refresh().catch((failure) => setLoadError(failure.message));
          }}
        >
          Try again
        </button>
      </>
    );
  if (!data) return <p role="status">Opening account settings…</p>;
  const hasPassword = data.methods.some(
    (method) => method.providerId === "credential",
  );
  const save = (event: FormEvent) => {
    event.preventDefault();
    void action.run(
      async () => {
        if (edit === "profile")
          await api("/api/v1/account/profile", { name, color }, "PATCH");
        if (edit === "email")
          await api("/api/auth/change-email", {
            newEmail: email,
            callbackURL: `${location.origin}/login`,
          });
        if (edit === "password")
          await api(
            hasPassword
              ? "/api/auth/change-password"
              : "/api/v1/account/password",
            hasPassword
              ? {
                  currentPassword: password,
                  newPassword,
                  revokeOtherSessions: true,
                }
              : { newPassword },
          );
        if (edit === "codes") {
          const result = await api<{ backupCodes: string[] }>(
            "/api/auth/two-factor/generate-backup-codes",
            password ? { password } : {},
          );
          setCodes(result.backupCodes);
        }
        if (edit === "delete") {
          await api("/api/v1/account/delete", { confirm });
          location.replace("/login");
        }
        if (edit !== "codes") setEdit(null);
        setPassword("");
        setNewPassword("");
      },
      edit === "email"
        ? "Check your current and new inboxes to confirm this change."
        : edit === "password"
          ? "Password updated. Sign in again if prompted, then reconnect your apps."
          : edit === "codes"
            ? "New recovery codes are shown once below."
            : "Changes saved.",
    );
  };
  return (
    <>
      <h1>Account and security</h1>
      <p>Choose how you sign in and control where you stay signed in.</p>
      {action.feedback}
      <section className="identity-section">
        <Row
          title={data.user.name}
          description={`${data.user.email} · ${data.localUsername ? "Studio account" : data.verified ? "verified" : "verification pending"}`}
        >
          <button
            disabled={action.busy}
            onClick={() => setEdit(edit === "profile" ? null : "profile")}
          >
            Edit profile
          </button>
        </Row>
        <Row
          title="Email address"
          description={
            data.localUsername && !data.emailVerified
              ? authSnapshot()?.email
                ? "Add an address to get email notifications and reset your password by email. You sign in with your username either way."
                : "You can add an address for email notifications and password resets after an administrator connects Studio email."
              : "Your current address stays in use until the new one is confirmed."
          }
        >
          <button
            disabled={action.busy || !authSnapshot()?.email}
            onClick={() => setEdit(edit === "email" ? null : "email")}
          >
            {data.localUsername && !data.emailVerified
              ? "Add email"
              : "Change email"}
          </button>
        </Row>
        <Row
          title="Password"
          description={
            hasPassword
              ? "Changing your password signs out existing sessions and disconnects apps."
              : "Add a password as another sign-in method. You’ll sign in again afterward."
          }
        >
          <button
            disabled={action.busy}
            onClick={() => setEdit(edit === "password" ? null : "password")}
          >
            {hasPassword ? "Change password" : "Add password"}
          </button>
        </Row>
        {data.localUsername && (
          <>
            <Row
              title="Account recovery key"
              description="Gets you back into this account if you forget your password or lose your devices, without email. Replacing it makes the old key stop working."
            >
              <button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const result = await api<{ recoveryCode: string }>(
                      "/api/v1/account/local-recovery-key",
                      {},
                    );
                    setLocalRecoveryKey(result.recoveryCode);
                  })
                }
              >
                Replace recovery key
              </button>
            </Row>
            {localRecoveryKey && (
              <div className="identity-recovery-key">
                <code style={{ overflowWrap: "anywhere" }}>
                  {localRecoveryKey}
                </code>
                <button onClick={() => setLocalRecoveryKey("")}>
                  I’ve saved my key
                </button>
              </div>
            )}
          </>
        )}
        <Row
          title="Passkeys"
          description="Use your device’s screen lock. A passkey can satisfy your second factor."
        >
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(() =>
                passkeyAction(
                  "add",
                  `Passkey ${new Date().toLocaleDateString()}`,
                ),
              )
            }
          >
            Add passkey
          </button>
        </Row>
        {data.passkeys.map((key) => (
          <Row
            key={key.id}
            title={key.name || "Passkey"}
            description={`${key.backedUp ? "Synced passkey" : "Device passkey"} · added ${new Date(key.createdAt).toLocaleDateString()}`}
          >
            <PasskeyName id={key.id} name={key.name} action={action} />
            <button
              disabled={action.busy}
              className="identity-danger"
              onClick={() =>
                void action.run(() =>
                  api("/api/auth/passkey/delete-passkey", { id: key.id }),
                )
              }
            >
              Remove
            </button>
          </Row>
        ))}
        <Row
          title="Authenticator"
          description={
            data.twoFactorEnabled
              ? "Two-factor authentication is enabled."
              : "Use a six-digit code from an authenticator app."
          }
        >
          <button
            disabled={action.busy}
            onClick={() =>
              setEdit(edit === "authenticator" ? null : "authenticator")
            }
          >
            {data.twoFactorEnabled ? "Manage" : "Set up"}
          </button>
        </Row>
        <Row
          title="Recovery codes"
          description={
            data.twoFactorEnabled
              ? "One-time codes for signing in when you don’t have your authenticator app. Replacing them makes the old codes stop working."
              : "One-time codes for signing in without your authenticator app. You get them when you set one up."
          }
        >
          <button
            disabled={!data.twoFactorEnabled || action.busy}
            onClick={() => {
              setCodes(undefined);
              setEdit(edit === "codes" ? null : "codes");
            }}
          >
            Replace codes
          </button>
        </Row>
      </section>
      {edit && (
        <section className="identity-section">
          <h2>
            {edit === "profile"
              ? "Your profile"
              : edit === "email"
                ? "Change your email address"
                : edit === "password"
                  ? "Set a new password"
                  : edit === "codes"
                    ? "Replace recovery codes"
                    : edit === "delete"
                      ? "Delete this account"
                      : "Authenticator settings"}
          </h2>
          {edit === "authenticator" ? (
            data.twoFactorEnabled ? (
              <>
                <p>
                  If your Studio requires two-factor authentication, add a working
                  passkey before removing your authenticator.
                </p>
                <Field
                  label="Current password"
                  name="disable-mfa-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={setPassword}
                  required={false}
                />
                <button
                  className="identity-danger"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      api(
                        "/api/auth/two-factor/disable",
                        password ? { password } : {},
                      ),
                    )
                  }
                >
                  Disable authenticator
                </button>
              </>
            ) : (
              <FactorEnrollment
                onComplete={refresh}
                hasPassword={hasPassword}
              />
            )
          ) : (
            <form onSubmit={save}>
              {edit === "profile" && (
                <>
                  <Field
                    label="Display name"
                    name="profile-name"
                    autoComplete="name"
                    value={name}
                    onChange={setName}
                  />
                  <MarkerColorField value={color} onChange={setColor} />
                </>
              )}
              {edit === "email" && (
                <Field
                  label="New email address"
                  name="new-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={setEmail}
                />
              )}{" "}
              {(edit === "password" || edit === "codes") && hasPassword && (
                <Field
                  label="Current password"
                  name="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={setPassword}
                />
              )}{" "}
              {edit === "password" && (
                <Field
                  label="New password"
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  hint="Use 15–128 characters. Avoid common or compromised passwords."
                  value={newPassword}
                  onChange={setNewPassword}
                />
              )}{" "}
              {edit === "delete" && (
                <>
                  <p>
                    Transfer or delete owned content first. Shared boards retain
                    their history with a deleted-account attribution.
                    Installation ownership must be transferred separately.
                  </p>
                  <Field
                    label={
                      data.localUsername
                        ? "Type your username"
                        : "Type your email address"
                    }
                    name="delete-confirmation"
                    autoComplete="off"
                    value={confirm}
                    onChange={setConfirm}
                  />
                </>
              )}
              {edit === "codes" && codes ? (
                <>
                  <div className="identity-codes">
                    {codes.map((code) => (
                      <code key={code}>{code}</code>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      download(
                        "open-whiteboard-recovery-codes.txt",
                        codes.join("\n"),
                        "text/plain",
                      )
                    }
                  >
                    Download codes
                  </button>
                </>
              ) : (
                <button
                  className={
                    edit === "delete" ? "identity-danger" : "identity-primary"
                  }
                  disabled={action.busy}
                  type="submit"
                >
                  {edit === "email"
                    ? "Send confirmation"
                    : edit === "codes"
                      ? "Generate replacement codes"
                      : edit === "delete"
                        ? "Delete account"
                        : "Save"}
                </button>
              )}
            </form>
          )}
          <button
            className="identity-link"
            onClick={() => {
              setEdit(null);
              setPassword("");
              setNewPassword("");
              setCodes(undefined);
            }}
          >
            Close
          </button>
        </section>
      )}
      <section className="identity-section">
        <h2>Sign-in providers</h2>
        {data.methods
          .filter((method) => method.providerId !== "credential")
          .map((method) => (
            <Row key={method.id} title={method.providerId}>
              <button
                className="identity-danger"
                disabled={action.busy}
                onClick={() =>
                  void action.run(() =>
                    api("/api/auth/unlink-account", {
                      accountId: method.id,
                    }),
                  )
                }
              >
                Unlink
              </button>
            </Row>
          ))}
        {authSnapshot()
          ?.providers?.filter(
            (provider) =>
              !data.methods.some((method) => method.providerId === provider),
          )
          .map((provider) => (
            <button
              key={provider}
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const value = await api<{ url: string }>(
                    "/api/auth/link-social",
                    {
                      provider,
                      providerId: provider,
                      callbackURL: `${location.origin}/settings/account`,
                      disableRedirect: true,
                    },
                  );
                  location.assign(value.url);
                })
              }
            >
              Link {provider}
            </button>
          ))}
        {data.methods.every((method) => method.providerId === "credential") &&
          !authSnapshot()?.providers?.length && (
            <p>No external providers are configured.</p>
          )}
      </section>
      <section className="identity-section">
        <h2>Devices and sessions</h2>
        <p>Device descriptions come from the browser and may be incomplete.</p>
        {data.sessions.map((session) => (
          <Row
            key={session.id}
            title={
              session.current ? "This session" : deviceLabel(session.userAgent)
            }
            description={`Last active ${new Date(session.updatedAt).toLocaleString()} · expires ${new Date(session.expiresAt).toLocaleDateString()}`}
          >
            <button
              className="identity-danger"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api(
                    `/api/v1/account/sessions/${encodeURIComponent(session.id)}`,
                    undefined,
                    "DELETE",
                  );
                  if (session.current) location.replace("/login");
                })
              }
            >
              Sign out
            </button>
          </Row>
        ))}
        <div className="identity-actions">
          <button
            className="identity-danger"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api("/api/v1/account/logout-all", {});
                location.replace("/login");
              })
            }
          >
            Sign out all devices
          </button>
          <button
            className="identity-danger"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api("/api/v1/account/secure", {});
                location.replace("/login");
              })
            }
          >
            Secure account and disconnect apps
          </button>
        </div>
      </section>
      <section className="identity-section">
        <h2>Recent security activity</h2>
        {data.events.length ? (
          data.events.map((event) => (
            <Row
              key={event.id}
              title={securityEventLabel(event.action)}
              description={`${new Date(event.created_at).toLocaleString()} · ${event.outcome}`}
            />
          ))
        ) : (
          <p>No recent security activity.</p>
        )}
      </section>
      <section className="identity-section">
        <h2>Your data</h2>
        <div className="identity-actions">
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const value = await api("/api/v1/account/export");
                download("canvas-account.json", JSON.stringify(value, null, 2));
              }, "Account export downloaded.")
            }
          >
            Export account information
          </button>
          <button
            className="identity-danger"
            disabled={action.busy}
            onClick={() => setEdit("delete")}
          >
            Delete account
          </button>
        </div>
      </section>
    </>
  );
}
function PasskeyName({
  id,
  name,
  action,
}: {
  id: string;
  name: string;
  action: ReturnType<typeof useAction>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name || "Passkey");
  return editing ? (
    <form
      className="identity-actions"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          await api("/api/auth/passkey/update-passkey", { id, name: value });
          setEditing(false);
        });
      }}
    >
      <input
        aria-label="Passkey name"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={80}
      />
      <button disabled={action.busy} type="submit">
        Save
      </button>
      <button type="button" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  ) : (
    <button onClick={() => setEditing(true)}>Rename</button>
  );
}
function deviceLabel(value: string | null) {
  return value?.includes("Firefox")
    ? "Firefox"
    : value?.includes("Edg/")
      ? "Microsoft Edge"
      : value?.includes("Chrome")
        ? "Chrome"
        : value?.includes("Safari")
          ? "Safari"
          : "Browser session";
}
export function download(
  name: string,
  value: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
