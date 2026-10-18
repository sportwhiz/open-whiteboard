import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../auth-client";
import { Field, Feedback, Submit, useAction } from "../auth-ui";
import { ConfirmDialog } from "./ConfirmDialog";
import { InviteLinkPanel } from "./InviteLinkPanel";
import "./invite-link.css";

type Invite = {
  id: string;
  label: string;
  role: string;
  expires_at: number;
  accepted_by: string | null;
  revoked_at: number | null;
};
const roleName = (role: string) => (role === "guest" ? "Guest" : "Member");
const linkFor = (token: string) =>
  `${location.origin}/invite#localInvite=${encodeURIComponent(token)}`;

export function LocalInvitations() {
  const [label, setLabel] = useState(""),
    [role, setRole] = useState("member");
  const [rows, setRows] = useState<Invite[]>([]),
    [loadError, setLoadError] = useState("");
  // Links created on this page, by invitation. They exist only in memory:
  // the server stores a hash and can never show them again.
  const [links, setLinks] = useState<Record<string, string>>({});
  const [focusId, setFocusId] = useState<string>();
  const [revoking, setRevoking] = useState<Invite>();
  const panels = useRef(new Map<string, { focus: () => void }>());
  const heading = useRef<HTMLHeadingElement>(null);
  const refresh = async () =>
    setRows(
      (await api<{ invitations: Invite[] }>("/api/v1/admin/local-invitations"))
        .invitations,
    );
  // Failed actions that need a fresh verification are retried automatically
  // once the administrator confirms it's them (StepUp in action.feedback).
  const action = useAction(refresh);
  useEffect(() => {
    void refresh().catch((failure) => setLoadError(failure.message));
  }, []);
  // Move to the new link's Copy button once its row is on screen.
  useEffect(() => {
    if (!focusId) return;
    const panel = panels.current.get(focusId);
    if (!panel) return;
    panel.focus();
    setFocusId(undefined);
  }, [focusId, rows]);
  const remember = (id: string, token: string) => {
    setLinks((current) => ({ ...current, [id]: linkFor(token) }));
    setFocusId(id);
  };
  const forget = (id: string) =>
    setLinks((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  function create(event: FormEvent) {
    event.preventDefault();
    const name = label.trim();
    void action.run(async () => {
      const value = await api<{ id: string; token: string }>(
        "/api/v1/admin/local-invitations",
        { label, role },
      );
      remember(value.id, value.token);
      setLabel("");
    }, `Invitation for ${name} created. Copy the link and send it to them.`);
  }
  const reissue = (row: Invite) =>
    void action.run(async () => {
      const value = await api<{ id: string; token: string }>(
        `/api/v1/admin/local-invitations/${encodeURIComponent(row.id)}/reissue`,
        {},
      );
      forget(row.id);
      remember(value.id, value.token);
    }, `New link created for ${row.label}. The previous link no longer works.`);
  const revoke = (row: Invite) =>
    void action.run(async () => {
      await api(
        `/api/v1/admin/local-invitations/${encodeURIComponent(row.id)}/revoke`,
        {},
      );
      forget(row.id);
      // The row is about to disappear; keep focus in this section.
      heading.current?.focus();
    }, `Invitation for ${row.label} revoked.`);
  const now = Date.now();
  const open = rows.filter((row) => !row.accepted_by && !row.revoked_at);
  const past = rows.filter((row) => row.accepted_by || row.revoked_at);
  return (
    <section className="identity-section">
      <h2 ref={heading} tabIndex={-1}>Invite without email</h2>
      <p>
        Share a private, single-use link. They’ll choose their own username and
        password. Links expire after seven days; board access is shared
        separately. Each link is shown only once; if one is lost, create a new
        link for that invitation.
      </p>
      <form onSubmit={create}>
        <div className="identity-form-grid">
          <Field
            label="Who is it for?"
            name="local-invite-label"
            value={label}
            onChange={setLabel}
            hint="A name to help you recognize this invitation."
          />
          <label className="identity-field">
            <span>Studio role</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              <option value="member">Member</option>
              <option value="guest">Guest</option>
            </select>
          </label>
        </div>
        <Submit busy={action.busy}>Create private invitation</Submit>
      </form>
      <Feedback error={loadError} />
      {action.feedback}
      {open.map((row) => {
        const expired = row.expires_at <= now;
        const link = links[row.id];
        return (
          <div className="identity-row invite-row" key={row.id}>
            <div>
              <strong>{row.label}</strong>
              <small>
                {roleName(row.role)} ·{" "}
                {expired
                  ? `Expired ${new Date(row.expires_at).toLocaleDateString()}`
                  : `Expires ${new Date(row.expires_at).toLocaleDateString()}`}
              </small>
            </div>
            <div className="identity-actions">
              {!link && (
                <button
                  type="button"
                  disabled={action.busy}
                  aria-label={`Create a new link for ${row.label}`}
                  onClick={() => reissue(row)}
                >
                  Create new link
                </button>
              )}
              {!expired && (
                <button
                  type="button"
                  className="identity-danger"
                  disabled={action.busy}
                  aria-label={`Revoke the invitation for ${row.label}`}
                  onClick={() => setRevoking(row)}
                >
                  Revoke
                </button>
              )}
            </div>
            {link && (
              <InviteLinkPanel
                ref={(panel) => {
                  if (panel) panels.current.set(row.id, panel);
                  else panels.current.delete(row.id);
                }}
                link={link}
                title={`Private invitation link for ${row.label}`}
                onDone={() => forget(row.id)}
              />
            )}
          </div>
        );
      })}
      {past.length > 0 && (
        <details className="invite-history">
          <summary>
            Accepted and revoked invitations ({past.length})
          </summary>
          {past.map((row) => (
            <div className="identity-row" key={row.id}>
              <div>
                <strong>{row.label}</strong>
                <small>
                  {roleName(row.role)} ·{" "}
                  {row.accepted_by ? "Accepted" : "Revoked"}
                </small>
              </div>
            </div>
          ))}
        </details>
      )}
      {revoking && (
        <ConfirmDialog
          title={`Revoke the invitation for ${revoking.label}?`}
          confirmLabel="Revoke invitation"
          destructive
          onCancel={() => setRevoking(undefined)}
          onConfirm={() => {
            const row = revoking;
            setRevoking(undefined);
            revoke(row);
          }}
        >
          <p>
            {revoking.label} won’t be able to use this link. This can’t be
            undone.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
