import { z } from "zod";

export const managedAgentProfileSchema = z.enum([
  "frontmind-base",
  "frontmind-pro",
]);

export type ManagedAgentProfile = z.infer<typeof managedAgentProfileSchema>;

export const DEFAULT_MANAGED_AGENT_PROFILE: ManagedAgentProfile =
  "frontmind-pro";

export function normalizeManagedAgentProfile(
  value: unknown,
): ManagedAgentProfile {
  return value === "frontmind-base"
    ? "frontmind-base"
    : DEFAULT_MANAGED_AGENT_PROFILE;
}

export function managedAgentProfileModel(profile: ManagedAgentProfile) {
  return profile === "frontmind-base" ? "manus-1.6" : "manus-1.6-max";
}
