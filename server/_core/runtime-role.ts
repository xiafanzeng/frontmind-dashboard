export const FRONTMIND_RUNTIME_ROLES = [
  "combined",
  "web",
  "siteops-worker",
] as const;

export type FrontMindRuntimeRole = (typeof FRONTMIND_RUNTIME_ROLES)[number];

/**
 * Keep the legacy combined role as the default so an older deployment
 * configuration cannot silently stop background processing. New deployments
 * set the role explicitly and isolate SiteOps from the public HTTP process.
 */
export function resolveFrontMindRuntimeRole(
  raw = process.env.FRONTMIND_RUNTIME_ROLE,
): FrontMindRuntimeRole {
  const candidate = raw?.trim() || "combined";
  if ((FRONTMIND_RUNTIME_ROLES as readonly string[]).includes(candidate)) {
    return candidate as FrontMindRuntimeRole;
  }
  throw new Error("FRONTMIND_RUNTIME_ROLE_INVALID");
}

export function runtimeRoleServesWeb(role: FrontMindRuntimeRole) {
  return role !== "siteops-worker";
}

export function runtimeRoleRunsSiteOps(role: FrontMindRuntimeRole) {
  return role !== "web";
}
