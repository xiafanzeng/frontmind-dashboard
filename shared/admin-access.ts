export type AdminAccessLevel = "system_admin" | "delivery_admin";

export function isExplicitAdminAccessLevel(
  value: unknown,
): value is AdminAccessLevel {
  return value === "system_admin" || value === "delivery_admin";
}

export function hasExplicitAdminRole(user: {
  role: unknown;
  adminAccessLevel?: unknown;
}) {
  return (
    user.role === "admin" && isExplicitAdminAccessLevel(user.adminAccessLevel)
  );
}

export function isProtectedBuiltinAdminUsername(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.normalize("NFKC").trim().toLowerCase() === "admin"
  );
}
