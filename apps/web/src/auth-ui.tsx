import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { UiIcon, type UiIconName } from "./UiIcon";
import { OnboardingArt, type OnboardingArtKind } from "./OnboardingArt";
import { WelcomeBoard } from "./WelcomeBoard";
import { BrandMark } from "./BrandMark";
import { PRODUCT_NAME, PRODUCT_WORDMARK } from "./product";
import { ThemeMenu } from "./theme";
import {
  api,
  ApiError,
  authSnapshot,
  bootstrapAuth,
  type AuthBootstrap,
} from "./auth-client";
import { useDialogFocus } from "./useDialogFocus";
import "./auth.css";

export function Brand() {
  return (
    <a className="identity-brand" href="/" aria-label={`${PRODUCT_NAME} home`}>
      <BrandMark />
      <strong className="brand-wordmark">{PRODUCT_WORDMARK}</strong>
    </a>
  );
}
export function AuthFrame({ title, description, children, footer, progress, icon, illustration }: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  progress?: { current: number; steps: string[] };
  icon?: UiIconName;
  illustration?: OnboardingArtKind;
}) {
  return (
    <main className="identity-page">
      <div className="identity-panel">
        <header className="identity-header"><Brand /></header>
        <div className="identity-form-column">
          <section className="identity-card" aria-labelledby="identity-title">
            {progress && <p className="identity-eyebrow">Step {progress.current + 1} of {progress.steps.length}</p>}
            {icon && <span className="identity-context-icon"><UiIcon name={icon} /></span>}
            <h1 id="identity-title">{title}</h1>
            {description && <p className="identity-description">{description}</p>}
            {children}
          </section>
          {progress && <ol className="identity-setup-steps" aria-label="Installation setup">
            {progress.steps.map((label, index) => <li key={label} className={index === progress.current ? "current" : index < progress.current ? "complete" : ""} aria-current={index === progress.current ? "step" : undefined}>
              <span className="identity-step-number">{index < progress.current ? <UiIcon name="check" /> : String(index + 1).padStart(2, "0")}</span>
              <strong>{label}</strong>
            </li>)}
          </ol>}
        </div>
        {footer && <footer className="identity-footer">{footer}</footer>}
      </div>
      {illustration && illustration !== "notes" ? <aside className="identity-context-art" aria-label="Studio illustration"><OnboardingArt kind={illustration} /></aside> : <WelcomeBoard />}
      <div className="identity-appearance"><ThemeMenu /></div>
    </main>
  );
}
export function Field({
  label,
  name,
  type = "text",
  autoComplete,
  value,
  onChange,
  hint,
  required = true,
  autoFocus = false,
  step,
  inputMode,
  error,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  required?: boolean;
  autoFocus?: boolean;
  step?: number | string;
  inputMode?: "text" | "numeric";
  /** A problem with this field, shown under it and announced with it. */
  error?: string;
}) {
  const [visible, setVisible] = useState(false);
  const fieldId = useId();
  const password = type === "password";
  return (
    <label className="identity-field">
      <span id={`${fieldId}-label`}>{label}</span>
      <div className={password ? "identity-password" : ""}>
        <input
          name={name}
          aria-labelledby={`${fieldId}-label`}
          type={password && visible ? "text" : type}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          autoFocus={autoFocus}
          step={step}
          inputMode={inputMode}
          aria-describedby={[hint && !error ? `${fieldId}-hint` : "", error ? `${fieldId}-error` : ""].filter(Boolean).join(" ") || undefined}
          aria-invalid={error ? true : undefined}
        />
        {password && (
          <button
            type="button"
            aria-label={visible ? "Hide password" : "Show password"}
            onClick={() => setVisible(!visible)}
          >
            {visible ? "Hide" : "Show"}
          </button>
        )}
      </div>
      {hint && !error && <small id={`${fieldId}-hint`}>{hint}</small>}
      {error && <small className="field-error" id={`${fieldId}-error`}>{error}</small>}
    </label>
  );
}
export function Feedback({
  error,
  notice,
}: {
  error?: string;
  notice?: string;
}) {
  return (
    <>
      {error && (
        <p className="identity-message error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="identity-message" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
export function Submit({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <button className="identity-primary" disabled={busy} type="submit">
      {busy ? "Please wait…" : children}
    </button>
  );
}
export async function passkeyAction(kind: "sign-in" | "add", name?: string) {
  const auth = await bootstrapAuth();
  const [{ createAuthClient }, { passkeyClient }] = await Promise.all([
    import("better-auth/client"),
    import("@better-auth/passkey/client"),
  ]);
  const client = createAuthClient({
    baseURL: location.origin,
    plugins: [passkeyClient()],
    fetchOptions: { headers: { "X-Canvas-CSRF": auth.csrf ?? "" } },
  });
  const result =
    kind === "sign-in"
      ? await client.signIn.passkey()
      : await client.passkey.addPasskey({ name });
  if (result.error) {
    // Application errors arrive as { error, code }; library ones as { message }.
    const failure = result.error as {
      message?: string;
      error?: string;
      code?: string;
      status?: number;
    };
    throw new ApiError(
      failure.message ??
        failure.error ??
        "The passkey operation was canceled or could not be completed.",
      failure.code ?? "PASSKEY_FAILED",
      failure.status ?? 400,
    );
  }
  return result.data;
}
/** The confirmation a protected change needs, given this account's methods. */
export function stepUpMethods(account: AuthBootstrap["account"] | undefined) {
  const totp = Boolean(account?.twoFactorEnabled);
  const passkey = Boolean(account?.hasPasskey);
  // Accounts that must use a second factor confirm with it; a password alone
  // only refreshes the verification time of a session without one.
  const factor = Boolean(account?.secondFactorReason) && (totp || passkey);
  const password = !factor && account?.hasPassword !== false;
  return { totp: factor && totp, passkey, password };
}
export function StepUp({
  onComplete,
  onCancel,
}: {
  onComplete: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  useDialogFocus(dialog, true, () => {
    if (!busy) onCancel();
  });
  const methods = stepUpMethods(authSnapshot()?.account);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const typed = methods.totp || methods.password;
  const description = methods.totp
    ? methods.passkey
      ? "Enter the six-digit code from your authenticator app, or use your passkey."
      : "Enter the six-digit code from your authenticator app."
    : methods.password
      ? methods.passkey
        ? "Enter your password, or use your passkey."
        : "Enter your password to continue."
      : methods.passkey
        ? "Use your passkey to continue."
        : "Sign out, then sign in again to confirm it’s you.";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (methods.totp) {
        if (!code.trim())
          throw new Error("Enter the code from your authenticator app.");
        await api("/api/auth/two-factor/verify-totp", { code: code.trim() });
      } else {
        if (!password) throw new Error("Enter your password.");
        await api("/api/v1/account/step-up", { password });
      }
      await bootstrapAuth(true);
      onComplete();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Confirmation failed.",
      );
    } finally {
      setPassword("");
      setCode("");
      setBusy(false);
    }
  };
  const usePasskey = () => {
    setBusy(true);
    setError("");
    void passkeyAction("sign-in")
      .then(() => bootstrapAuth(true))
      .then(onComplete)
      .catch((failure) => setError(failure.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="identity-dialog-backdrop">
      <section
        ref={dialog}
        tabIndex={-1}
        className="identity-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="step-up-title"
        aria-describedby="step-up-description"
      >
        <h2 id="step-up-title">Confirm it’s you</h2>
        <p id="step-up-description">{description}</p>
        <Feedback error={error} />
        <form onSubmit={submit}>
          {methods.totp ? (
            <Field
              label="Authenticator code"
              name="confirm-code"
              autoComplete="one-time-code"
              inputMode="numeric"
              value={code}
              onChange={setCode}
              autoFocus
            />
          ) : methods.password ? (
            <Field
              label="Password"
              name="confirm-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={setPassword}
              autoFocus
            />
          ) : null}
          {typed && methods.passkey && (
            <button
              className="identity-secondary"
              type="button"
              disabled={busy}
              onClick={usePasskey}
            >
              Use a passkey instead
            </button>
          )}
          <div className="identity-dialog-actions">
            <button
              className="identity-secondary"
              type="button"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </button>
            {typed ? (
              <button className="identity-primary" type="submit" disabled={busy}>
                {busy ? "Checking…" : "Confirm"}
              </button>
            ) : methods.passkey ? (
              <button
                className="identity-primary"
                type="button"
                disabled={busy}
                onClick={usePasskey}
              >
                {busy ? "Waiting for passkey…" : "Use your passkey"}
              </button>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  );
}
export function useAction(refresh: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Which form the latest result belongs to. A scoped result is shown by that
  // form (for example inside its save bar), not in the page-level feedback.
  const [scope, setScope] = useState<string | undefined>();
  const [retry, setRetry] = useState<(() => Promise<unknown>) | null>(null);
  const run = async (
    task: () => Promise<unknown>,
    success = "Changes saved.",
    options: { scope?: string } = {},
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    setScope(options.scope);
    try {
      await task();
      await refresh();
      setNotice(success);
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "STEP_UP_REQUIRED")
        setRetry(() => () => run(task, success, options));
      else
        setError(
          failure instanceof Error
            ? failure.message
            : "This action could not be completed.",
        );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const clear = () => { setError(""); setNotice(""); };
  return {
    busy,
    error,
    notice,
    scope,
    run,
    clear,
    /** The latest result, if it belongs to the given form. */
    resultFor: (name: string) => scope === name ? { error, notice } : { error: "", notice: "" },
    feedback: (
      <>
        {scope ? null : <Feedback error={error} notice={notice} />}
        {retry && (
          <StepUp
            onComplete={() => {
              const action = retry;
              setRetry(null);
              void action();
            }}
            onCancel={() => setRetry(null)}
          />
        )}
      </>
    ),
  };
}
