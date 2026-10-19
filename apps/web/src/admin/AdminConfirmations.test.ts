import { describe, expect, it } from "vitest";
import { mfaRequirementMessage, roleChangeConsequences } from "./AdminConfirmations";

describe("administrative confirmation copy", () => {
  it("recommends a second factor for a new administrator without one", () => {
    const without = roleChangeConsequences({ name: "Mia", from: "member", to: "admin", hasSecondFactor: false });
    expect(without[0]).toBe("Mia will be signed out on all devices.");
    expect(without).toContain("An authenticator app is recommended for two-factor protection on Mia’s account.");
    const withFactor = roleChangeConsequences({ name: "Mia", from: "member", to: "admin", hasSecondFactor: true });
    expect(withFactor.join(" ")).not.toContain("passkey");
  });
  it("states the loss of administration and the limits of the guest role", () => {
    const lines = roleChangeConsequences({ name: "Ada", from: "admin", to: "guest", hasSecondFactor: true }).join(" ");
    expect(lines).toContain("Ada will lose access to Studio administration.");
    expect(lines).toContain("can’t create folders or workbooks");
  });
  it("counts people without a second factor", () => {
    expect(mfaRequirementMessage(1)).toMatch(/^1 person doesn’t have/);
    expect(mfaRequirementMessage(3)).toMatch(/^3 people don’t have/);
  });
});
