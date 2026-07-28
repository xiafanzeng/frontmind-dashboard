import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { hasExplicitAdminRole } from "../../shared/admin-access";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Please log in" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!hasExplicitAdminRole(ctx.user)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Explicit administrator permission is required",
    });
  }
  return next({ ctx });
});
