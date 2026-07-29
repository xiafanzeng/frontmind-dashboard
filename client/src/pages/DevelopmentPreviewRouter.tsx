import { Redirect } from "wouter";

import { PreviewUserBrandDashboard } from "@/dashboard/UserBrandDashboard";
import {
  adminDashboardPreviewFixtures,
  userPreviewFixtures,
} from "@/lib/development-preview-fixtures";
import {
  previewAdminPageHref,
  previewAdminWorkspaceHref,
} from "@/lib/preview-navigation";
import AdminDashboard from "@/pages/AdminDashboard";
import {
  PreviewAdminAccounts,
  PreviewAdminAgent,
  PreviewAdminPresales,
  PreviewAdminUsers,
} from "@/pages/PreviewPages";

type DevelopmentPreviewRouterProps = {
  location: string;
};

/**
 * Development/acceptance-only routes.
 *
 * App imports this module behind an import.meta.env.DEV guarded dynamic
 * import. Do not import it from a production route or authenticated feature.
 */
export default function DevelopmentPreviewRouter({
  location,
}: DevelopmentPreviewRouterProps) {
  const route = location.split("?")[0];

  switch (route) {
    case "/preview/user":
      return (
        <PreviewUserBrandDashboard
          initialSection="brand"
          fixtures={userPreviewFixtures}
        />
      );
    case "/preview/user/basic":
      return (
        <PreviewUserBrandDashboard
          initialSection="brand"
          planCode="basic"
          fixtures={userPreviewFixtures}
        />
      );
    case "/preview/user/advanced":
      return (
        <PreviewUserBrandDashboard
          initialSection="brand"
          planCode="advanced"
          fixtures={userPreviewFixtures}
        />
      );
    case "/preview/user/luxury":
      return (
        <PreviewUserBrandDashboard
          initialSection="brand"
          planCode="luxury"
          fixtures={userPreviewFixtures}
        />
      );
    case "/preview/user/knowledge":
      return (
        <PreviewUserBrandDashboard
          initialSection="knowledge-agent"
          planCode="knowledge"
          fixtures={userPreviewFixtures}
        />
      );
    case "/preview/admin/delivery":
    case "/preview/admin":
      return (
        <AdminDashboard
          preview
          previewAccessLevel="delivery_admin"
          previewFixtures={adminDashboardPreviewFixtures}
        />
      );
    case "/preview/admin/system":
      return (
        <AdminDashboard
          preview
          previewAccessLevel="system_admin"
          previewFixtures={adminDashboardPreviewFixtures}
        />
      );
    case previewAdminWorkspaceHref("delivery_admin"):
      return <PreviewAdminUsers previewAccessLevel="delivery_admin" />;
    case previewAdminWorkspaceHref("system_admin"):
      return <PreviewAdminUsers previewAccessLevel="system_admin" />;
    case previewAdminPageHref("delivery_admin", "agent"):
      return <PreviewAdminAgent previewAccessLevel="delivery_admin" />;
    case previewAdminPageHref("system_admin", "agent"):
      return <PreviewAdminAgent previewAccessLevel="system_admin" />;
    case previewAdminPageHref("system_admin", "presales"):
      return <PreviewAdminPresales />;
    case previewAdminPageHref("system_admin", "accounts"):
      return <PreviewAdminAccounts />;
    case "/preview/admin/agent":
      return <Redirect to={previewAdminPageHref("system_admin", "agent")} />;
    case "/preview/admin/workflow":
      return <Redirect to={previewAdminPageHref("system_admin", "agent")} />;
    case "/preview/admin/presales":
      return <Redirect to={previewAdminPageHref("system_admin", "presales")} />;
    case "/preview/admin/users":
      return <Redirect to={previewAdminWorkspaceHref("system_admin")} />;
    case "/preview/admin/accounts":
      return <Redirect to={previewAdminPageHref("system_admin", "accounts")} />;
    default:
      return null;
  }
}
