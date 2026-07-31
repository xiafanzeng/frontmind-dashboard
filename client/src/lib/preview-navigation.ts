import {
  Activity,
  Bot,
  BriefcaseBusiness,
  Database,
  Gauge,
  Home as HomeIcon,
  Send,
  UserCog,
  Users,
} from "lucide-react";

import type { PortalNavItem } from "@/components/PortalShell";

export type PreviewAdminAccessLevel = "delivery_admin" | "system_admin";

export const previewIssueMonitorUrl =
  "https://business.molizhishu.com/business/dashboard?view=projects";
export const previewChannelDistributionUrl = "https://i.kol.cn/";

export const previewUserNav: PortalNavItem[] = [
  { label: "企业看板", href: "/preview/user", icon: HomeIcon },
  { label: "知识库智能体", href: "/preview/user/knowledge", icon: Database },
];

export const previewAdminNav: PortalNavItem[] = [
  {
    label: "交付总览",
    href: "/preview/admin",
    icon: Gauge,
    group: "运营",
  },
  {
    label: "客户交付工作台",
    href: "/preview/admin/users",
    icon: UserCog,
    group: "客户与服务",
  },
  {
    label: "官网任务与积分",
    href: "/preview/admin/presales",
    icon: BriefcaseBusiness,
    group: "客户与服务",
  },
  {
    label: "账号与权限",
    href: "/preview/admin/accounts",
    icon: Users,
    group: "系统管理",
  },
  {
    label: "问题监控",
    href: previewIssueMonitorUrl,
    icon: Activity,
    group: "外部系统",
    external: true,
    newWindow: true,
  },
  {
    label: "渠道分发",
    href: previewChannelDistributionUrl,
    icon: Send,
    group: "外部系统",
    external: true,
    newWindow: true,
  },
];

const previewDeliveryAdminNav: PortalNavItem[] = [
  previewAdminNav[0],
  previewAdminNav[1],
  {
    label: "FrontMind Agent",
    href: "/preview/admin/agent",
    icon: Bot,
    group: "Agent 与资源",
  },
];

export function previewAdminRootHref(
  accessLevel: PreviewAdminAccessLevel,
): string {
  return `/preview/admin/${
    accessLevel === "system_admin" ? "system" : "delivery"
  }`;
}

export function previewAdminWorkspaceHref(
  accessLevel: PreviewAdminAccessLevel,
): string {
  return previewAdminPageHref(accessLevel, "workspace");
}

export function previewAdminPageHref(
  accessLevel: PreviewAdminAccessLevel,
  page: "workspace" | "agent" | "presales" | "accounts",
): string {
  return `${previewAdminRootHref(accessLevel)}/${page}`;
}

/**
 * Keep a preview administrator's role in the URL for every internal page.
 *
 * Acceptance pages do not have an authenticated server session, so a shared
 * `/preview/admin/users` route cannot safely infer whether it was opened by a
 * delivery or system administrator. Role-scoped paths prevent navigation from
 * silently upgrading a delivery administrator to the system fixture.
 */
export function getRoleScopedPreviewAdminNav(
  accessLevel: PreviewAdminAccessLevel,
): PortalNavItem[] {
  const systemAdmin = accessLevel === "system_admin";
  const sourceNav = systemAdmin ? previewAdminNav : previewDeliveryAdminNav;
  const root = previewAdminRootHref(accessLevel);
  const internalHrefMap: Record<string, string> = {
    "/preview/admin": root,
    "/preview/admin/users": previewAdminPageHref(accessLevel, "workspace"),
    "/preview/admin/agent": previewAdminPageHref(accessLevel, "agent"),
    "/preview/admin/presales": previewAdminPageHref(accessLevel, "presales"),
    "/preview/admin/accounts": previewAdminPageHref(accessLevel, "accounts"),
  };

  return sourceNav.map((item) => ({
    ...item,
    href: internalHrefMap[item.href] ?? item.href,
  }));
}
