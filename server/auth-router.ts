import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "../shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import {
  AuthServiceError,
  SESSION_DURATION_MS,
  changeOwnPassword,
  getSessionTokenFromRequest,
  loginWithPassword,
  revokeSessionToken,
} from "./auth-service";

const passwordSchema = z
  .string()
  .min(12, "Password must contain at least 12 characters")
  .max(128, "Password is too long");

export function toTrpcError(error: unknown): TRPCError {
  if (!(error instanceof AuthServiceError)) {
    return new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The request could not be completed",
      cause: error,
    });
  }

  switch (error.code) {
    case "INVALID_PASSWORD":
      return new TRPCError({ code: "UNAUTHORIZED", message: error.message });
    case "ACCOUNT_DISABLED":
      return new TRPCError({ code: "FORBIDDEN", message: error.message });
    case "RATE_LIMITED":
      return new TRPCError({ code: "TOO_MANY_REQUESTS", message: error.message });
    case "CONFLICT":
    case "LAST_ADMIN":
      return new TRPCError({ code: "CONFLICT", message: error.message });
    case "NOT_FOUND":
      return new TRPCError({ code: "NOT_FOUND", message: error.message });
    case "INVALID_CREDENTIAL":
      return new TRPCError({ code: "BAD_REQUEST", message: error.message });
    case "UPSTREAM_UNAVAILABLE":
      return new TRPCError({ code: "BAD_GATEWAY", message: error.message });
    case "DATABASE_UNAVAILABLE":
    case "INVALID_MASTER_KEY":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The service is not configured correctly",
        cause: error,
      });
  }
}

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) => ctx.user),

  login: publicProcedure
    .input(
      z.object({
        username: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(128),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const clientAddress =
          ctx.req.ip || ctx.req.socket?.remoteAddress || "unknown";
        const result = await loginWithPassword(
          input.username,
          input.password,
          clientAddress
        );
        ctx.res.cookie(COOKIE_NAME, result.token, {
          ...getSessionCookieOptions(ctx.req),
          sameSite: "lax",
          maxAge: SESSION_DURATION_MS,
        });
        return {
          user: result.user,
          expiresAt: result.session.expiresAt,
        };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    await revokeSessionToken(getSessionTokenFromRequest(ctx.req));
    ctx.res.clearCookie(COOKIE_NAME, {
      ...getSessionCookieOptions(ctx.req),
      sameSite: "lax",
      maxAge: -1,
    });
    return { success: true } as const;
  }),

  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1).max(128),
        newPassword: passwordSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await changeOwnPassword(
          ctx.user.id,
          input.currentPassword,
          input.newPassword,
          getSessionTokenFromRequest(ctx.req)
        );
        return { success: true } as const;
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
});

export { passwordSchema };
