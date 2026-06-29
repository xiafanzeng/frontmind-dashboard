import type { Request } from "express";

const UPSTREAM_VENDOR = ["ma", "nus"].join("");
const DEFAULT_UPSTREAM_BASE_URL = `https://api.${UPSTREAM_VENDOR}.im`;

export function getUpstreamBaseUrl(req?: Request) {
  const configured = process.env.FRONTMIND_UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL;
  const allowClientOverride = process.env.FRONTMIND_ALLOW_CLIENT_BASE_URL === "1";
  const clientBaseUrl =
    allowClientOverride && req
      ? String(req.headers["x-frontmind-base-url"] || "")
      : "";

  return (clientBaseUrl || configured).replace(/\/$/, "");
}

export function getFrontMindApiKey(req: Request) {
  return String(
    process.env.FRONTMIND_API_KEY ||
    req.headers["x-frontmind-api-key"] ||
    ""
  );
}

export function getFrontMindCredentials(req: Request) {
  return {
    apiKey: getFrontMindApiKey(req),
    baseUrl: getUpstreamBaseUrl(req),
  };
}

export function toUpstreamAgentProfile(agentProfile?: string) {
  switch (agentProfile) {
    case "frontmind-lite":
      return `${UPSTREAM_VENDOR}-1.6-lite`;
    case "frontmind-base":
      return `${UPSTREAM_VENDOR}-1.6`;
    case "frontmind-pro":
    case undefined:
    case "":
      return `${UPSTREAM_VENDOR}-1.6-max`;
    default:
      return agentProfile;
  }
}

export function translateTaskBodyForUpstream<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }

  const next = { ...(body as Record<string, unknown>) };
  if (typeof next.agentProfile === "string") {
    next.agentProfile = toUpstreamAgentProfile(next.agentProfile);
  }
  return next as T;
}
