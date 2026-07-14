import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import {
  deleteActiveApiCredential,
  getApiCredentialStatus,
  replaceApiCredential,
} from "./auth-service";
import { toTrpcError } from "./auth-router";

const apiKeyInput = z.object({
  apiKey: z.string().trim().min(8, "API Key is too short").max(4096),
});

async function saveCredential(userId: number, apiKey: string) {
  try {
    return await replaceApiCredential(userId, apiKey);
  } catch (error) {
    throw toTrpcError(error);
  }
}

export const credentialRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await getApiCredentialStatus(ctx.user.id);
    } catch (error) {
      throw toTrpcError(error);
    }
  }),

  set: protectedProcedure
    .input(apiKeyInput)
    .mutation(({ ctx, input }) => saveCredential(ctx.user.id, input.apiKey)),

  replace: protectedProcedure
    .input(apiKeyInput)
    .mutation(({ ctx, input }) => saveCredential(ctx.user.id, input.apiKey)),

  delete: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      await deleteActiveApiCredential(ctx.user.id);
      return { success: true } as const;
    } catch (error) {
      throw toTrpcError(error);
    }
  }),
});
