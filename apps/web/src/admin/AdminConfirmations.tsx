import { ConfirmDialog } from "./ConfirmDialog";

const roleNames: Record<string, string> = {
  owner: "Owner",
  admin: "Administrator",
  member: "Member",
  guest: "Guest",
};
export const roleName = (role: string | null | undefined) =>
  role ? (roleNames[role] ?? role) : "Not admitted";

/** What changing a Studio role does to the person, in the order it happens. */
export function roleChangeConsequences(input: {
  name: string;
  from: string | null;
  to: string;
  hasSecondFactor: boolean;
}) {
  const { name, from, to } = input;
  const lines = [`${name} will be signed out on all devices.`];
  if (to === "admin") {
    lines.push(
      "Administrators can manage people and invitations for the whole Studio.",
    );
    if (!input.hasSecondFactor)
      lines.push(
        `Administrators must use a passkey or authenticator app, so ${name} will be asked to set one up at the next sign-in.`,
      );
  } else if (from === "admin")
    lines.push(`${name} will lose access to Studio administration.`);
  if (to === "guest")
    lines.push(
      `As a guest, ${name} can still open boards and workbooks they already have access to, but can’t create folders or workbooks.`,
    );
  else if (from === "guest")
    lines.push(`As a member, ${name} can create their own folders, workbooks and boards.`);
  lines.push(`${name} will get a notification explaining the change.`);
  return lines;
}

export function RoleChangeConfirm({
  person,
  role,
  onConfirm,
  onCancel,
}: {
  person: {
    name: string;
    role: string | null;
    twoFactorEnabled?: number;
    passkeys?: number;
  };
  role: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const lines = roleChangeConsequences({
    name: person.name,
    from: person.role,
    to: role,
    hasSecondFactor: Boolean(person.twoFactorEnabled || person.passkeys),
  });
  return (
    <ConfirmDialog
      title={
        role === "admin"
          ? `Make ${person.name} an Administrator?`
          : `Change ${person.name}’s role to ${roleName(role)}?`
      }
      confirmLabel={
        role === "admin" ? "Make Administrator" : `Change to ${roleName(role)}`
      }
      destructive={role !== "admin"}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </ConfirmDialog>
  );
}

/** "3 people don't have…" — the impact of requiring a second factor. */
export function mfaRequirementMessage(withoutSecondFactor: number) {
  const n = withoutSecondFactor;
  return `${n} ${n === 1 ? "person doesn’t" : "people don’t"} have a passkey or authenticator app yet. The next time they open the Studio, they’ll be asked to set one up before they can open boards.`;
}

export function MfaRequirementConfirm({
  withoutSecondFactor,
  onConfirm,
  onCancel,
}: {
  withoutSecondFactor: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      title="Require a second factor for everyone?"
      confirmLabel="Require second factor"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>{mfaRequirementMessage(withoutSecondFactor)}</p>
      <p>
        People already signed in will be asked on their next page load.
        Connected apps pause until each person confirms them again.
      </p>
    </ConfirmDialog>
  );
}
