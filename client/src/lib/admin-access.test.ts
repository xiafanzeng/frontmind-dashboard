import { describe, expect, it } from "vitest";

import type { AuthUser } from "@/_core/hooks/useAuth";
import { isDeliveryAdminAccount, isSystemAdminAccount } from "./admin-access";

function admin(
  adminAccessLevel: AuthUser["adminAccessLevel"],
  username = "admin",
): AuthUser {
  return {
    id: 1,
    username,
    displayName: "管理员",
    role: "admin",
    adminAccessLevel,
    isActive: true,
  };
}

describe("client administrator access", () => {
  it("grants system access only from the explicit access level", () => {
    expect(isSystemAdminAccount(admin("system_admin", "not-admin"))).toBe(true);
    expect(isSystemAdminAccount(admin("delivery_admin", "admin"))).toBe(false);
    expect(isSystemAdminAccount(admin(null, "admin"))).toBe(false);
  });

  it("does not reinterpret a missing level as delivery access", () => {
    expect(isDeliveryAdminAccount(admin("delivery_admin"))).toBe(true);
    expect(isDeliveryAdminAccount(admin("system_admin"))).toBe(false);
    expect(isDeliveryAdminAccount(admin(null))).toBe(false);
  });
});
