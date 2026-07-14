import type { NextFunction, Request, Response } from "express";
import {
  AuthServiceError,
  authenticateRequest,
  getDecryptedCredentialForUser,
  type AuthenticatedUser,
  type DecryptedCredential,
} from "../auth-service";

export type FrontMindRequest = Request & {
  frontmindUser?: AuthenticatedUser;
  frontmindCredential?: DecryptedCredential;
};

function sendAuthError(res: Response, status: number, message: string, code: string) {
  res.status(status).json({ error: { message, code } });
}

export async function requireExpressAuth(
  req: FrontMindRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = await authenticateRequest(req);
    if (!user) {
      sendAuthError(res, 401, "请先登录", "UNAUTHORIZED");
      return;
    }
    req.frontmindUser = user;
    next();
  } catch (error) {
    console.error("[Auth] Express authentication failed", error);
    sendAuthError(res, 503, "登录服务暂不可用", "AUTH_UNAVAILABLE");
  }
}

export async function attachActiveCredential(
  req: FrontMindRequest,
  res: Response,
  next: NextFunction,
) {
  if (!req.frontmindUser) {
    sendAuthError(res, 401, "请先登录", "UNAUTHORIZED");
    return;
  }

  try {
    const credential = await getDecryptedCredentialForUser(req.frontmindUser.id);
    if (!credential) {
      sendAuthError(res, 428, "请先在账号设置中配置 API Key", "API_CREDENTIAL_REQUIRED");
      return;
    }
    req.frontmindCredential = credential;
    next();
  } catch (error) {
    const invalidKey = error instanceof AuthServiceError && error.code === "INVALID_MASTER_KEY";
    console.error("[Credential] Failed to load account credential", error);
    sendAuthError(
      res,
      503,
      invalidKey ? "服务端凭据加密配置无效" : "API Key 暂不可用",
      invalidKey ? "CREDENTIAL_ENCRYPTION_UNAVAILABLE" : "CREDENTIAL_UNAVAILABLE",
    );
  }
}

/**
 * Loads the active credential when one exists, while allowing authenticated
 * routes that do not call the upstream API (for example workflow manifests)
 * to remain usable before a key is configured.
 */
export async function attachOptionalActiveCredential(
  req: FrontMindRequest,
  res: Response,
  next: NextFunction,
) {
  if (!req.frontmindUser) {
    sendAuthError(res, 401, "请先登录", "UNAUTHORIZED");
    return;
  }

  try {
    const credential = await getDecryptedCredentialForUser(req.frontmindUser.id);
    if (credential) req.frontmindCredential = credential;
    next();
  } catch (error) {
    const invalidKey = error instanceof AuthServiceError && error.code === "INVALID_MASTER_KEY";
    console.error("[Credential] Failed to load account credential", error);
    sendAuthError(
      res,
      503,
      invalidKey ? "服务端凭据加密配置无效" : "API Key 暂不可用",
      invalidKey ? "CREDENTIAL_ENCRYPTION_UNAVAILABLE" : "CREDENTIAL_UNAVAILABLE",
    );
  }
}
