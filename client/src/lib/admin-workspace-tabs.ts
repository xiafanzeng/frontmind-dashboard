export const ADMIN_WORKSPACE_TAB_IDS = [
  "service",
  "knowledge",
  "tickets",
  "delivery",
  "credential",
  "activity",
] as const;

export type WorkspaceTab = (typeof ADMIN_WORKSPACE_TAB_IDS)[number];
