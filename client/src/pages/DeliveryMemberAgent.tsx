import { useEffect, useState } from "react";

import Home from "@/pages/Home";
import PortalShell from "@/components/PortalShell";
import { trpc } from "@/lib/trpc";
import { deliveryMemberNav } from "@/pages/DeliveryMemberDashboard";
import { DELIVERY_ROLE_STORAGE_KEY } from "@/lib/frontmind-api";
import { DELIVERY_ROLE_LABELS } from "@shared/delivery-roles";

export default function DeliveryMemberAgent() {
  const credential = trpc.delivery.mine.credentialStatus.useQuery();
  const roles = trpc.delivery.mine.roles.useQuery();
  const [roleAssignmentId, setRoleAssignmentId] = useState(() =>
    typeof window === "undefined"
      ? ""
      : localStorage.getItem(DELIVERY_ROLE_STORAGE_KEY) || "",
  );
  useEffect(() => {
    if (
      roles.data?.length &&
      !roles.data.some((role) => role.assignmentId === roleAssignmentId)
    ) {
      setRoleAssignmentId(roles.data[0]!.assignmentId);
    }
  }, [roleAssignmentId, roles.data]);
  useEffect(() => {
    if (roleAssignmentId) {
      localStorage.setItem(DELIVERY_ROLE_STORAGE_KEY, roleAssignmentId);
    }
  }, [roleAssignmentId]);
  return (
    <PortalShell
      mode="fullscreen"
      eyebrow="交付成员 · 工具"
      title="通用智能体"
      navItems={deliveryMemberNav}
      roleLabel={
        credential.data?.configured
          ? "API Key 已由交付管理员配置"
          : "API Key 尚未配置，请联系交付管理员"
      }
      toolbar={
        roles.data?.length ? (
          <select
            aria-label="当前工作角色"
            className="h-10 rounded-md border bg-card px-3 text-sm"
            value={roleAssignmentId}
            onChange={(event) => setRoleAssignmentId(event.target.value)}
          >
            {roles.data.map((role) => (
              <option key={role.assignmentId} value={role.assignmentId}>
                {DELIVERY_ROLE_LABELS[role.roleType]} · {role.teamName}
              </option>
            ))}
          </select>
        ) : undefined
      }
    >
      <section className="h-full min-h-0 overflow-hidden bg-white">
        {roleAssignmentId ? (
          <Home
            embedded
            hidePortalNavigation
            showKnowledgeBaseStarter={false}
            showAccountMenu={false}
            showSettings={false}
            standardWelcomeVariant="workflow"
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            请先联系交付管理员配置工作角色
          </div>
        )}
      </section>
    </PortalShell>
  );
}
