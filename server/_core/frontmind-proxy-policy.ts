import type { NextFunction, Response } from "express";
import { hasExplicitAdminRole } from "../../shared/admin-access";

import type { FrontMindRequest } from "./express-auth";
import {
  assertServiceWriteAccess,
  ServiceEntitlementError,
} from "../service-entitlement";

const ORDINARY_USER_SUPPORT_OPERATIONS = new Set([
  "POST /download-token",
  "POST /v1/files",
  "PUT /proxy-upload",
]);

function proxyPath(req: Pick<FrontMindRequest, "originalUrl">) {
  try {
    return new URL(req.originalUrl, "http://frontmind.local").pathname.replace(
      /^\/api\/frontmind/,
      "",
    );
  } catch {
    return "";
  }
}

/**
 * The generic proxy remains the administrator Agent workbench and the
 * read/download transport for resources created by dedicated customer
 * workflows. Customer accounts may upload attachments, but cannot create,
 * continue, cancel, or mutate model tasks through this escape hatch.
 */
export function ordinaryUserMayUseFrontMindProxy(
  req: Pick<FrontMindRequest, "method" | "originalUrl">,
) {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }
  return ORDINARY_USER_SUPPORT_OPERATIONS.has(`${method} ${proxyPath(req)}`);
}

export function ordinaryUserProxyWriteRequiresActiveService(
  req: Pick<FrontMindRequest, "method" | "originalUrl">,
) {
  const operation = `${req.method.toUpperCase()} ${proxyPath(req)}`;
  return operation === "POST /v1/files" || operation === "PUT /proxy-upload";
}

export function createFrontMindProxyAccessMiddleware(
  dependencies: {
    assertWriteAccess: typeof assertServiceWriteAccess;
  } = { assertWriteAccess: assertServiceWriteAccess },
) {
  return async (req: FrontMindRequest, res: Response, next: NextFunction) => {
    const user = req.frontmindUser;
    if (!user) {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    if (user.role === "admin") {
      if (hasExplicitAdminRole(user)) {
        next();
      } else {
        res.status(403).json({
          error: {
            message: "管理员权限尚未配置",
            code: "ADMIN_ACCESS_LEVEL_REQUIRED",
          },
        });
      }
      return;
    }
    if (!ordinaryUserMayUseFrontMindProxy(req)) {
      res.status(403).json({
        error: {
          message:
            "用户看板只能通过对应服务流程调用模型；通用智能体操作仅向管理员开放",
          code: "GENERAL_AGENT_MUTATION_FORBIDDEN",
        },
      });
      return;
    }
    if (ordinaryUserProxyWriteRequiresActiveService(req)) {
      try {
        await dependencies.assertWriteAccess(user.id);
      } catch (error) {
        if (error instanceof ServiceEntitlementError) {
          res.status(error.statusCode).json({
            error: { message: error.message, code: error.code },
          });
          return;
        }
        throw error;
      }
    }
    next();
  };
}

export const enforceFrontMindProxyAccess =
  createFrontMindProxyAccessMiddleware();
