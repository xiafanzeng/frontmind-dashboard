import { z } from "zod";

import { deliveryRoleTypeSchema } from "../shared/delivery-roles";
import { passwordSchema, toTrpcError } from "./auth-router";
import {
  assignDeliveryCustomer,
  createDeliveryMember,
  createDeliveryRole,
  dispatchDeliveryTicket,
  getMyDeliveryCredentialStatus,
  getMyDeliveryWorkbench,
  listDeliveryRoleManagement,
  listMyDeliveryRoles,
  setDeliveryMemberCredential,
  revokeDeliveryMemberCredential,
  setDeliveryRoleMember,
  updateMyDeliveryTicket,
  urgeDeliveryTicket,
} from "./delivery-role-service";
import { adminProcedure, protectedProcedure, router } from "./_core/trpc";
import {
  decideKnowledgeReset,
  previewKnowledgeReset,
} from "./knowledge-base-reset-service";

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/);

function serviceCall<T>(callback: () => Promise<T>) {
  return callback().catch((error) => {
    throw toTrpcError(error);
  });
}

export const deliveryRoleRouter = router({
  management: router({
    overview: adminProcedure.query(({ ctx }) =>
      serviceCall(() => listDeliveryRoleManagement(ctx.user)),
    ),
    createTeam: adminProcedure
      .input(
        z.object({
          name: z.string().trim().min(2).max(128),
          roleType: deliveryRoleTypeSchema,
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() => createDeliveryRole({ actor: ctx.user, ...input })),
      ),
    createMember: adminProcedure
      .input(
        z.object({
          username: usernameSchema,
          password: passwordSchema,
          displayName: z.string().trim().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() => createDeliveryMember({ actor: ctx.user, ...input })),
      ),
    setMember: adminProcedure
      .input(
        z.object({
          roleId: z.string().uuid(),
          memberUserId: z.number().int().positive(),
          active: z.boolean(),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() => setDeliveryRoleMember({ actor: ctx.user, ...input })),
      ),
    assignCustomer: adminProcedure
      .input(
        z.object({
          customerUserId: z.number().int().positive(),
          roleType: deliveryRoleTypeSchema,
          roleId: z.string().uuid(),
          primaryMemberId: z.number().int().positive(),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          assignDeliveryCustomer({ actor: ctx.user, ...input }),
        ),
      ),
    dispatchTicket: adminProcedure
      .input(
        z.object({
          ticketId: z.string().uuid(),
          roleId: z.string().uuid(),
          memberUserId: z.number().int().positive(),
          priority: z.enum(["low", "normal", "high", "urgent"]),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          dispatchDeliveryTicket({ actor: ctx.user, ...input }),
        ),
      ),
    urgeTicket: adminProcedure
      .input(
        z.object({
          ticketId: z.string().uuid(),
          message: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() => urgeDeliveryTicket({ actor: ctx.user, ...input })),
      ),
    setMemberApiKey: adminProcedure
      .input(
        z.object({
          memberUserId: z.number().int().positive(),
          apiKey: z.string().trim().min(8).max(4096),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          setDeliveryMemberCredential({ actor: ctx.user, ...input }),
        ),
      ),
    revokeMemberApiKey: adminProcedure
      .input(z.object({ memberUserId: z.number().int().positive() }))
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          revokeDeliveryMemberCredential({ actor: ctx.user, ...input }),
        ),
      ),
  }),
  mine: router({
    roles: protectedProcedure.query(({ ctx }) =>
      serviceCall(() => listMyDeliveryRoles(ctx.user)),
    ),
    workbench: protectedProcedure
      .input(z.object({ roleAssignmentId: z.string().uuid() }))
      .query(({ ctx, input }) =>
        serviceCall(() =>
          getMyDeliveryWorkbench({ actor: ctx.user, ...input }),
        ),
      ),
    credentialStatus: protectedProcedure.query(({ ctx }) =>
      serviceCall(() => getMyDeliveryCredentialStatus(ctx.user)),
    ),
    knowledgeResetPreview: protectedProcedure
      .input(
        z.object({
          roleAssignmentId: z.string().uuid(),
          requestId: z.string().uuid(),
        }),
      )
      .query(({ ctx, input }) =>
        serviceCall(() => previewKnowledgeReset({ actor: ctx.user, ...input })),
      ),
    decideKnowledgeReset: protectedProcedure
      .input(
        z.object({
          roleAssignmentId: z.string().uuid(),
          requestId: z.string().uuid(),
          expectedRevision: z.number().int().positive(),
          decision: z.enum(["approve", "reject"]),
          decisionNote: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() => decideKnowledgeReset({ actor: ctx.user, ...input })),
      ),
    updateTicket: protectedProcedure
      .input(
        z.object({
          roleAssignmentId: z.string().uuid(),
          ticketId: z.string().uuid(),
          expectedRevision: z.number().int().positive(),
          status: z.enum([
            "in_progress",
            "needs_information",
            "completed",
            "rejected",
            "cancelled",
          ]),
          message: z.string().trim().max(8_000).optional(),
          publicUrl: z.string().url().max(4_096).optional(),
          handoff: z
            .object({
              monitoringBatchKey: z.string().trim().max(191).optional(),
              optimizationQuestionIds: z
                .array(z.string().trim().min(1).max(191))
                .max(100)
                .optional(),
              responseLogicRevision: z.number().int().positive().optional(),
              contentAssetIds: z
                .array(z.string().trim().min(1).max(191))
                .max(500)
                .optional(),
              publishTargets: z
                .array(z.enum(["media", "website"]))
                .max(2)
                .optional(),
              websiteOperation: z
                .enum([
                  "company_facts",
                  "product_case_docs",
                  "industry_news",
                  "company_news",
                  "faq_content",
                ])
                .optional(),
              needsFurtherOptimization: z.boolean().optional(),
              domain: z.string().trim().max(512).optional(),
              icpProvince: z.string().trim().max(64).optional(),
              icpNumber: z.string().trim().max(128).optional(),
              icpNotRequired: z.boolean().optional(),
              siteCheck: z
                .object({
                  key: z.string().trim().min(1).max(64),
                  label: z.string().trim().min(1).max(160),
                  status: z.enum([
                    "passed",
                    "warning",
                    "failed",
                    "not_applicable",
                  ]),
                  summary: z.string().trim().max(8_000).optional(),
                  evidence: z.string().trim().max(8_000).optional(),
                  source: z.string().trim().max(4_096).optional(),
                })
                .optional(),
            })
            .optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          updateMyDeliveryTicket({ actor: ctx.user, ...input }),
        ),
      ),
  }),
});
