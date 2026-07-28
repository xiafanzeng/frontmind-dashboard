import { z } from "zod";
import { adminProcedure, router } from "./_core/trpc";
import {
  AuthServiceError,
  deleteActiveApiCredential,
  getDecryptedCredentialForUser,
  getApiCredentialStatus,
  replaceApiCredential,
  validateUpstreamApiKey,
} from "./auth-service";
import { toTrpcError } from "./auth-router";

const apiKeyInput = z.object({
  apiKey: z.string().trim().min(8, "API Key is too short").max(4096),
});

const testApiKeyInput = z.object({
  apiKey: z.string().trim().min(8, "API Key is too short").max(4096).optional(),
});

async function saveCredential(userId: number, apiKey: string) {
  try {
    return await replaceApiCredential(userId, apiKey);
  } catch (error) {
    throw toTrpcError(error);
  }
}

export const credentialRouter = router({
  status: adminProcedure.query(async ({ ctx }) => {
    try {
      return await getApiCredentialStatus(ctx.user.id);
    } catch (error) {
      throw toTrpcError(error);
    }
  }),

  set: adminProcedure
    .input(apiKeyInput)
    .mutation(({ ctx, input }) => saveCredential(ctx.user.id, input.apiKey)),

  replace: adminProcedure
    .input(apiKeyInput)
    .mutation(({ ctx, input }) => saveCredential(ctx.user.id, input.apiKey)),

  test: adminProcedure
    .input(testApiKeyInput)
    .mutation(async ({ ctx, input }) => {
      try {
        const savedCredential = input.apiKey
          ? null
          : await getDecryptedCredentialForUser(ctx.user.id);
        const apiKey = input.apiKey ?? savedCredential?.apiKey;
        if (!apiKey) {
          throw new AuthServiceError("NOT_FOUND", "请先填写或保存 API Key");
        }
        await validateUpstreamApiKey(apiKey);
        return { ok: true } as const;
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  delete: adminProcedure.mutation(async ({ ctx }) => {
    try {
      await deleteActiveApiCredential(ctx.user.id);
      return { success: true } as const;
    } catch (error) {
      throw toTrpcError(error);
    }
  }),
});
