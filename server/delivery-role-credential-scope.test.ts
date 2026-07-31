import { describe, expect, it } from "vitest";

import {
  assertDeliveryMemberCredentialVersion,
  decideEngineerCredentialManagementScope,
} from "./delivery-role-service";

describe("delivery engineer credential management scope", () => {
  const decide = (
    assignmentAdminIds: Array<number | null>,
    createdByAdminId: number | null = null,
    systemAdmin = false,
  ) =>
    decideEngineerCredentialManagementScope({
      systemAdmin,
      actorUserId: 10,
      assignmentAdminIds,
      createdByAdminId,
    });

  it("allows the administrator who owns all assigned customer projects", () => {
    expect(decide([10, 10])).toMatchObject({
      manageable: true,
      managerAdminIds: [10],
    });
  });

  it("rejects another administrator and any shared or unowned portfolio", () => {
    expect(decide([20])).toMatchObject({ manageable: false });
    expect(decide([10, 20])).toMatchObject({
      manageable: false,
      reason: expect.stringContaining("多个交付管理员"),
    });
    expect(decide([10, null])).toMatchObject({
      manageable: false,
      reason: expect.stringContaining("尚未明确"),
    });
  });

  it("uses origin only while the engineer has no customer assignments", () => {
    expect(decide([], 10)).toMatchObject({ manageable: true });
    expect(decide([], 20)).toMatchObject({ manageable: false });
  });

  it("allows a system administrator across all scopes", () => {
    expect(decide([10, 20, null], null, true)).toMatchObject({
      manageable: true,
      managerAdminIds: [10, 20],
    });
  });

  it("rejects a stale concurrent credential version", () => {
    expect(() =>
      assertDeliveryMemberCredentialVersion({
        actualVersion: 4,
        expectedVersion: 3,
      }),
    ).toThrow("工程师 API Key 状态已变化，请刷新后重试");
    expect(() =>
      assertDeliveryMemberCredentialVersion({
        actualVersion: 4,
        expectedVersion: 4,
      }),
    ).not.toThrow();
  });
});
