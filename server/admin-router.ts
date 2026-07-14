import { z } from "zod";
import { adminProcedure, router } from "./_core/trpc";
import {
  createManagedUser,
  deleteManagedUser,
  listManagedUsers,
  resetManagedUserPassword,
  setManagedUserActive,
} from "./auth-service";
import { passwordSchema, toTrpcError } from "./auth-router";

const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must contain at least 3 characters")
  .max(64, "Username is too long")
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "Username may only contain letters, numbers, dots, underscores, and hyphens"
  );

export const adminRouter = router({
  users: router({
    list: adminProcedure.query(async () => {
      try {
        return { users: await listManagedUsers() };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

    create: adminProcedure
      .input(
        z.object({
          username: usernameSchema,
          password: passwordSchema,
          displayName: z.string().trim().max(128).optional(),
          role: z.enum(["user", "admin"]).default("user"),
        })
      )
      .mutation(async ({ input }) => {
        try {
          const user = await createManagedUser(input);
          return { user };
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    resetPassword: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          newPassword: passwordSchema,
        })
      )
      .mutation(async ({ input }) => {
        try {
          await resetManagedUserPassword(input.userId, input.newPassword);
          return { success: true } as const;
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    setActive: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          isActive: z.boolean(),
        })
      )
      .mutation(async ({ input }) => {
        try {
          const user = await setManagedUserActive(input.userId, input.isActive);
          return { user };
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    delete: adminProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        try {
          await deleteManagedUser(ctx.user.id, input.userId);
          return { success: true } as const;
        } catch (error) {
          throw toTrpcError(error);
        }
      }),
  }),
});
