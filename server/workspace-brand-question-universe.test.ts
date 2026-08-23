import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./auth-service";

const mocks = vi.hoisted(() => ({
  observeBrandQuestionUniverse: vi.fn(),
  startBrandQuestionUniverse: vi.fn(),
}));

vi.mock("./brand-question-universe-service", () => ({
  BrandQuestionUniverseServiceError: class extends Error {
    constructor(
      readonly code: string,
      readonly statusCode: number,
      message: string,
    ) {
      super(message);
    }
  },
  observeBrandQuestionUniverse: mocks.observeBrandQuestionUniverse,
  startBrandQuestionUniverse: mocks.startBrandQuestionUniverse,
}));

import { workspaceRouter } from "./workspace-router";

const now = new Date("2026-08-24T00:00:00.000Z");

function context(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 7,
    openId: null,
    username: "question-universe-customer",
    displayName: "客户",
    name: "客户",
    email: null,
    loginMethod: "password",
    role: "user",
    adminAccessLevel: null,
    engineerRoleType: null,
    marketEdition: "overseas",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
  return {
    user,
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("workspace brand question universe router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.observeBrandQuestionUniverse.mockResolvedValue({ canStart: true });
    mocks.startBrandQuestionUniverse.mockResolvedValue({ canStart: false });
  });

  it("exposes the exact observe() and start(input) customer methods", async () => {
    const caller = workspaceRouter.createCaller(context());
    await expect(caller.brandQuestionUniverse.observe()).resolves.toEqual({
      canStart: true,
    });
    const value = {
      knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
      clientRequestId: "20000000-0000-4000-8000-000000000001",
      expectedDashboardRevision: 9,
    };
    await expect(caller.brandQuestionUniverse.start(value)).resolves.toEqual({
      canStart: false,
    });
    expect(mocks.observeBrandQuestionUniverse).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
    );
    expect(mocks.startBrandQuestionUniverse).toHaveBeenCalledWith({
      actor: expect.objectContaining({ id: 7 }),
      value,
    });
  });

  it("rejects a start request without all three frozen coordinates", async () => {
    const caller = workspaceRouter.createCaller(context());
    await expect(
      caller.brandQuestionUniverse.start({
        knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
        clientRequestId: "20000000-0000-4000-8000-000000000001",
      } as never),
    ).rejects.toBeDefined();
    expect(mocks.startBrandQuestionUniverse).not.toHaveBeenCalled();
  });
});
