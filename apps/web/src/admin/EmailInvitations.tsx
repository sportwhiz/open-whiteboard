import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, authSnapshot } from "../auth-client";
import type { useAction } from "../auth-ui";
import { ConfirmDialog } from "./ConfirmDialog";
import { InviteLinkPanel } from "./InviteLinkPanel";
import "./invite-link.css";

type Invite = {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};
export type CreatedInvitation = { id: string; email: string; link: string };
const roleName = (role: string) =>
  ({ admin: "Administrator", member: "Member", guest: "Guest" })[role] ?? role;

/**
 * Email invitations, each with its newly created link (shown once) and a
 * confirmed revoke. Renewing replaces the link; the old one stops working.
 */
export function EmailInvitationList({
  invitations,
  action,
  created,
  empty,
}: {
  invitations: Invite[];
  action: ReturnType<typeof useAction>;
  /** An invitation just created by the invitation form. */
  created?: CreatedInvitation;
  empty: ReactNode;
}) {
  const [links, setLinks] = useState<Record<string, CreatedInvitation>>({});
  const [focusId, setFocusId] = useState<string>();
  const [revoking, setRevoking] = useState<Invite>();
  const panels = useRef(new Map<string, { focus: () => void }>());
  const list = useRef<HTMLElement>(null);
  const remember = (value: CreatedInvitation) => {
    setLinks((current) => ({ ...current, [value.id]: value }));
    setFocusId(value.id);
  };
  const forget = (id: string) =>
    setLinks((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  useEffect(() => {
    if (created) remember(created);
  }, [created]);
  useEffect(() => {
    const panel = focusId && panels.current.get(focusId);
    if (!panel) return;
    panel.focus();
    setFocusId(undefined);
  }, [focusId, invitations, links]);
  const mail = Boolean(authSnapshot()?.email);
  const panel = (value: CreatedInvitation) => (
    <InviteLinkPanel
      ref={(item) => {
        if (item) panels.current.set(value.id, item);
        else panels.current.delete(value.id);
      }}
      link={value.link}
      title={`Invitation link for ${value.email}`}
      onDone={() => forget(value.id)}
    />
  );
  // A new invitation may sort onto another page; keep its link reachable.
  const detached = Object.values(links).filter(
    (value) => !invitations.some((item) => item.id === value.id),
  );
  return (
    <section
      ref={list}
      tabIndex={-1}
      aria-label="Email invitations"
      className="identity-section"
    >
      {detached.map((value) => (
        <div className="identity-row invite-row" key={value.id}>
          {panel(value)}
        </div>
      ))}
      {invitations.length
        ? invitations.map((item) => {
            const pending = !item.accepted_at && !item.revoked_at;
            const link = links[item.id];
            return (
              <div className="identity-row invite-row" key={item.id}>
                <div>
                  <strong>{item.email}</strong>
                  <small>
                    {roleName(item.role)} ·{" "}
                    {item.accepted_at
                      ? "accepted"
                      : item.revoked_at
                        ? "revoked"
                        : Date.parse(item.expires_at) <= Date.now()
                          ? "expired"
                          : `pending · expires ${new Date(item.expires_at).toLocaleDateString()}`}
                  </small>
                </div>
                {pending && (
                  <div className="identity-actions">
                    {!link && (
                      <button
                        type="button"
                        disabled={action.busy}
                        aria-label={`${mail ? "Email a new link to" : "Create a new link for"} ${item.email}`}
                        onClick={() =>
                          void action.run(
                            async () => {
                              const result = await api<{ link: string }>(
                                `/api/v1/admin/invitations/${encodeURIComponent(item.id)}/resend`,
                                { sendEmail: mail },
                              );
                              remember({ id: item.id, email: item.email, link: result.link });
                            },
                            mail
                              ? `New link emailed to ${item.email}. The previous link no longer works.`
                              : `New link created for ${item.email}. The previous link no longer works.`,
                          )
                        }
                      >
                        {mail ? "Resend with new link" : "Create new link"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="identity-danger"
                      disabled={action.busy}
                      aria-label={`Revoke the invitation for ${item.email}`}
                      onClick={() => setRevoking(item)}
                    >
                      Revoke
                    </button>
                  </div>
                )}
                {link && pending && panel(link)}
              </div>
            );
          })
        : empty}
      {revoking && (
        <ConfirmDialog
          title={`Revoke the invitation for ${revoking.email}?`}
          confirmLabel="Revoke invitation"
          destructive
          onCancel={() => setRevoking(undefined)}
          onConfirm={() => {
            const item = revoking;
            setRevoking(undefined);
            void action.run(async () => {
              await api(
                `/api/v1/admin/invitations/${encodeURIComponent(item.id)}/revoke`,
                {},
              );
              forget(item.id);
              list.current?.focus();
            }, `Invitation for ${item.email} revoked.`);
          }}
        >
          <p>
            {revoking.email} won’t be able to use the invitation link. This
            can’t be undone.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
