import { adminRouter } from "./admin-router";
import { authRouter } from "./auth-router";
import { conversationRouter } from "./conversation-router";
import { credentialRouter } from "./credential-router";
import { systemRouter } from "./_core/systemRouter";
import { router } from "./_core/trpc";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  admin: adminRouter,
  credential: credentialRouter,
  conversation: conversationRouter,
});

export type AppRouter = typeof appRouter;
