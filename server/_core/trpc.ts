import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { hasExplicitAdminRole } from "../../shared/admin-access";
import type { TrpcContext } from "./context";

const validationFieldLabels: Record<string, string> = {
  question: "目标问题",
  username: "用户名",
  password: "密码",
  apiKey: "API Key",
  userId: "用户",
  category: "类型",
  topic: "话题",
};

function localizedZodIssue(issue: ZodError["issues"][number]) {
  if (/[\u3400-\u9fff]/u.test(issue.message)) return issue.message;
  const rawField = String(issue.path.at(-1) ?? "输入内容");
  const field = validationFieldLabels[rawField] ?? rawField;
  const detail = issue as unknown as {
    code: string;
    minimum?: number;
    maximum?: number;
    format?: string;
  };
  if (detail.code === "too_small" && detail.minimum !== undefined) {
    return `${field}至少需要 ${detail.minimum} 个字符`;
  }
  if (detail.code === "too_big" && detail.maximum !== undefined) {
    return `${field}不能超过 ${detail.maximum} 个字符`;
  }
  if (detail.code === "invalid_type") return `${field}格式不正确`;
  if (detail.code === "invalid_format") return `${field}格式不正确`;
  return `${field}校验失败，请检查后重试`;
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    if (!(error.cause instanceof ZodError)) return shape;
    const issue = error.cause.issues[0];
    return {
      ...shape,
      message: issue ? localizedZodIssue(issue) : "提交内容校验失败",
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "请先登录" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!hasExplicitAdminRole(ctx.user)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "需要明确的管理员权限",
    });
  }
  return next({ ctx });
});
