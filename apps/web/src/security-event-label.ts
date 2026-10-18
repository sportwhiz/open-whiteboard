const labels: Record<string, string> = {
  "updates.connection_saved": "Update connection saved",
  "updates.disconnected": "Update connection disconnected",
  "updates.requested": "Software update requested",
  "updates.rollback_requested": "Compatible version restore requested",
  "updates.policy_changed": "Automatic update preference changed",
  "updates.preparation_cancelled": "Stalled update preparation cleared",
  "updates.deployment_retried": "Stopped deployment retried",
  "updates.verified": "Updated deployment verified",
  "auth.sign-in.local":"Username sign-in",
  "auth.setup.local":"Local account created",
  "auth.recover.local":"Account recovery started",
  "account.recovery_key_replaced":"Account recovery key replaced",
  "local_invitation.created":"Private invitation created",
  "local_invitation.revoked":"Private invitation revoked",
  "local_invitation.reissued":"Private invitation link replaced",
  "invitation.revoked":"Invitation revoked",
  "auth.sign-in.email": "Password sign-in",
  "auth.two-factor.verify-totp": "Authenticator verified",
  "auth.two-factor.enable": "Authenticator enrollment started",
  "auth.two-factor.disable": "Authenticator removed",
  "auth.two-factor.verify-backup-code": "Recovery code verified",
  "auth.passkey.verify-authentication": "Signed in with a passkey",
  "auth.passkey.verify-registration": "Passkey added",
  "auth.operator-recovery": "Emergency recovery confirmed",
  "account.factor_recovered": "Recovery completed",
  "account.recovery_code_used": "Recovery started with a saved code",
  "account.emergency_recovery_started": "Emergency owner recovery started",
  "account.emergency_recovery_issued": "Operator issued an owner recovery link",
  "account.password_reset": "Password reset",
  "account.password_changed": "Password changed and access revoked",
  "account.password_added": "Password added",
  "account.secured": "Account secured and apps disconnected",
  "account.email_changed": "Email address changed",
  "session.all_revoked": "Signed out all devices",
  "session.revoked": "Session signed out",
  "oauth.permissions_confirmed": "App permissions confirmed",
  "oauth.consent_granted": "App connected",
  "oauth.disconnected": "App disconnected",
  "admin.content_transferred": "Content ownership transferred",
  "board.ownership_transferred": "Board ownership transferred",
  "workbook.ownership_transferred": "Workbook ownership transferred",
  "admin.approve": "Account approved",
  "admin.role": "Role changed",
  "admin.role_changed": "Role changed",
  "admin.secure": "Account secured",
  "admin.delete": "Account deleted",
  "auth.sign-out": "Signed out",
  "auth.setup.completed": "Installation set up",
  "admin.suspend": "Account suspended",
  "admin.restore": "Account restored",
  "installation.settings_changed": "Installation settings changed",
};
export function securityEventLabel(action: string) {
  const value = labels[action] ?? action.replaceAll(/[._/-]/g, " ");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export type SecurityEvent = {
  id: string; actor_id: string | null; target_id: string | null; action: string; outcome: string; metadata: string; created_at: string;
  actor_name?: string | null; target_name?: string | null;
};

/**
 * Events that one change records twice. The first action of each pair is
 * shown; the second is folded into it when both concern the same people
 * within a few seconds.
 */
const PAIRS: [string, string, string][] = [
  ['admin.role', 'admin.role_changed', 'admin.role_changed'],
  ['auth.setup.local', 'account.password_added', 'auth.setup.local'],
];

/** Merge paired events so each change reads as one row. Linear in the number of events. */
export function groupSecurityEvents<T extends SecurityEvent>(events: T[]): (T & { merged?: number })[] {
  const result: (T & { merged?: number })[] = [];
  for (const event of events) {
    const previous = result[result.length - 1];
    const pair = previous && PAIRS.find(([a, b]) => (previous.action === a && event.action === b) || (previous.action === b && event.action === a));
    const samePeople = previous && (previous.target_id ?? previous.actor_id) === (event.target_id ?? event.actor_id);
    const close = previous && Math.abs(Date.parse(previous.created_at) - Date.parse(event.created_at)) <= 5_000;
    if (pair && samePeople && close) {
      result[result.length - 1] = { ...previous, action: pair[2], merged: (previous.merged ?? 1) + 1 };
      continue;
    }
    result.push(event);
  }
  return result;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a date. */
export function relativeTime(value: string, now = Date.now()) {
  const seconds = Math.round((now - Date.parse(value)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)} d ago`;
  return new Date(value).toLocaleDateString();
}

/** Who did it, to whom: "Alex → Mia Member", "Mia Member" or "Unauthenticated request". */
export function securityEventPeople(event: SecurityEvent, currentUserId?: string) {
  const name = (id: string | null, label: string | null | undefined) => !id ? null : id === currentUserId ? 'You' : label?.trim() || 'Unknown account';
  const actor = name(event.actor_id, event.actor_name) ?? 'Unauthenticated request';
  const target = event.target_id && event.target_id !== event.actor_id ? name(event.target_id, event.target_name) : null;
  return target ? `${actor} → ${target}` : actor;
}
