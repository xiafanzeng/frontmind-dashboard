import { adminRouter } from "./admin-router";
import { authRouter } from "./auth-router";
import { conversationRouter } from "./conversation-router";
import { credentialRouter } from "./credential-router";
import { systemRouter } from "./_core/systemRouter";
import { router } from "./_core/trpc";
import { workspaceRouter } from "./workspace-router";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  admin: adminRouter,
  credential: credentialRouter,
  conversation: conversationRouter,
  workspace: workspaceRouter,
});

export type AppRouter = typeof appRouter;
