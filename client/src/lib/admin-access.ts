import type { AuthUser } from "@/_core/hooks/useAuth";
export function isSystemAdminAccount(
  user: AuthUser | null | undefined,
): boolean {
  return Boolean(
    user?.role === "admin" && user.adminAccessLevel === "system_admin",
  );
}

export function isDeliveryAdminAccount(
  user: AuthUser | null | undefined,
): boolean {
  return Boolean(
    user?.role === "admin" && user.adminAccessLevel === "delivery_admin",
  );
}
