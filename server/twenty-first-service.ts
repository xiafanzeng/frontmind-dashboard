import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  presalesApiCredentials,
  siteBuilds,
  siteOperations,
  websiteStyleSampleBatches,
  type PresalesApiCredential,
} from "../drizzle/schema";
import {
  AuthServiceError,
  decryptCredentialSecret,
  encryptCredentialSecret,
  getApiKeyFingerprint,
} from "./auth-service";
import { getDb } from "./db";

export const TWENTY_FIRST_CREDENTIAL_SLOT = "site_builder_21st";
export const TWENTY_FIRST_MCP_ENDPOINT = "https://21st.dev/api/mcp";

const TWENTY_FIRST_REQUEST_TIMEOUT_MS = 12_000;
const TWENTY_FIRST_TOTAL_TIMEOUT_MS = 90_000;
const TWENTY_FIRST_MAX_RESPONSE_BYTES = 1_000_000;
const TWENTY_FIRST_MAX_JSON_DEPTH = 32;
const TWENTY_FIRST_MAX_RETRY_AFTER_MS = 2_000;
const TWENTY_FIRST_MAX_HTTP_RETRIES = 1;
const TWENTY_FIRST_MAX_TOOL_PAGES = 3;
const TWENTY_FIRST_MAX_TOOLS = 100;

export type TwentyFirstCapabilities = {
  search: boolean;
  getComponent: boolean;
  getUsage: boolean | null;
  getTheme: boolean | null;
};

export type TwentyFirstCredentialStatus = {
  configured: boolean;
  revocationPending: boolean;
  fingerprint: string | null;
  status: "active" | "retired" | "invalid" | null;
  version: number | null;
  verifiedAt: number | null;
  updatedAt: number | null;
  capabilities: TwentyFirstCapabilities;
};

export type TwentyFirstConnectionResult = {
  ok: true;
  endpoint: typeof TWENTY_FIRST_MCP_ENDPOINT;
  capabilities: TwentyFirstCapabilities;
  server: { name: string; version: string } | null;
};

export type TwentyFirstActiveConsumerProbe = (
  credentialIds: readonly string[],
  executor: any,
) => Promise<boolean>;

export const TWENTY_FIRST_ACTIVE_OPERATION_STATUSES = [
  "queued",
  "running",
  "outcome_unknown",
] as const;

export async function hasActiveTwentyFirstConsumers(
  credentialIds: readonly string[],
  executor: any,
) {
  if (credentialIds.length === 0) return false;
  const [providerOperations, credentialBuilds, awaitingSelectionBoards] =
    await Promise.all([
      executor
        .select({ id: siteOperations.id })
        .from(siteOperations)
        .where(
          and(
            eq(siteOperations.provider, "21st"),
            inArray(
              siteOperations.status,
              TWENTY_FIRST_ACTIVE_OPERATION_STATUSES,
            ),
          ),
        )
        .limit(1)
        .for("update"),
      executor
        .select({ id: siteBuilds.id })
        .from(siteBuilds)
        .where(
          and(
            inArray(siteBuilds.twentyFirstCredentialId, [...credentialIds]),
            inArray(siteBuilds.status, [
              "preparing",
              "visual_searching",
              "awaiting_visual_selection",
              "design_compiling",
            ]),
          ),
        )
        .limit(1)
        .for("update"),
      // A published board is a durable output whose frozen credential version
      // must remain referenceable until the customer selects or re-searches.
      executor
        .select({ id: websiteStyleSampleBatches.id })
        .from(websiteStyleSampleBatches)
        .where(
          and(
            eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
            eq(websiteStyleSampleBatches.status, "published"),
          ),
        )
        .limit(1)
        .for("update"),
    ]);
  return Boolean(
    providerOperations[0] || credentialBuilds[0] || awaitingSelectionBoards[0],
  );
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

function twentyFirstCredentialAad(credentialId: string) {
  return `frontmind-21st-api-credential:v1:${TWENTY_FIRST_CREDENTIAL_SLOT}:${credentialId}`;
}

export function encryptTwentyFirstApiKey(credentialId: string, apiKey: string) {
  return encryptCredentialSecret(
    twentyFirstCredentialAad(credentialId),
    apiKey,
  );
}

export function decryptTwentyFirstApiKey(
  credential: Pick<
    PresalesApiCredential,
    | "id"
    | "encryptionVersion"
    | "encryptedKey"
    | "encryptionIv"
    | "encryptionAuthTag"
  >,
) {
  return decryptCredentialSecret(
    twentyFirstCredentialAad(credential.id),
    credential,
  );
}

export function validateTwentyFirstApiKeyInput(apiKey: string) {
  const value = apiKey.trim();
  if (value.length < 8) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "21st API Key 至少需要 8 个字符",
    );
  }
  if (value.length > 4_096) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "21st API Key 不能超过 4096 个字符",
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "21st API Key 包含无效控制字符",
    );
  }
  return value;
}

function createBoundedFetch(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxResponseBytes: number,
  options: {
    maxRetries?: number;
    maxRetryAfterMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  return async (url: string | URL, init?: RequestInit) => {
    const maxRetries = Math.max(
      0,
      Math.min(options.maxRetries ?? TWENTY_FIRST_MAX_HTTP_RETRIES, 2),
    );
    const maxRetryAfterMs = Math.max(
      0,
      Math.min(
        options.maxRetryAfterMs ?? TWENTY_FIRST_MAX_RETRY_AFTER_MS,
        5_000,
      ),
    );
    const sleep =
      options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    let response: Response | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal;
      response = await fetchImpl(url, { ...init, signal });
      if (response.status !== 429 || attempt === maxRetries) break;
      const header = response.headers.get("retry-after");
      const seconds = header ? Number(header) : Number.NaN;
      const absolute = header ? Date.parse(header) : Number.NaN;
      const requestedDelay = Number.isFinite(seconds)
        ? seconds * 1_000
        : Number.isFinite(absolute)
          ? Math.max(0, absolute - Date.now())
          : 250;
      await response.body?.cancel().catch(() => undefined);
      await sleep(Math.min(Math.max(0, requestedDelay), maxRetryAfterMs));
    }
    if (!response) throw new Error("21st response missing");
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
      throw new Error("21st response exceeded the configured size limit");
    }
    if (!response.body) return response;

    let receivedBytes = 0;
    const boundedBody = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > maxResponseBytes) {
            controller.error(
              new Error("21st response exceeded the configured size limit"),
            );
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(boundedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

type TwentyFirstAdvertisedTool = {
  name: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    [key: string]: unknown;
  };
};

export type TwentyFirstProviderItemId = string | number;

export type TwentyFirstSearchRequest = {
  query: string;
  type: "component";
  limit: number;
  tag?: "hero";
  sort?: "recommended";
};

export type TwentyFirstReadOnlySession = {
  /** Maximum search depth actually accepted by the live advertised schema. */
  effectiveSearchLimit?: number;
  search(input: TwentyFirstSearchRequest): Promise<unknown>;
  getComponent?: (
    providerItemId: TwentyFirstProviderItemId,
  ) => Promise<unknown>;
};

export class TwentyFirstToolContractError extends AuthServiceError {
  constructor() {
    super("UPSTREAM_UNAVAILABLE", "21st 工具参数协议暂不兼容");
    this.name = "TwentyFirstToolContractError";
  }
}

function canonicalToolInputKey(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
}

function findToolInputKey(
  tool: TwentyFirstAdvertisedTool,
  candidates: readonly string[],
) {
  const wanted = new Set(candidates.map(canonicalToolInputKey));
  return Object.keys(tool.inputSchema.properties ?? {}).find((key) =>
    wanted.has(canonicalToolInputKey(key)),
  );
}

function compatibleEnumValue(
  property: object | undefined,
  candidates: readonly string[],
) {
  const declared = Array.isArray(
    (property as { enum?: unknown } | undefined)?.enum,
  );
  const values = declared
    ? ((property as { enum: unknown[] }).enum ?? [])
    : null;
  return values
    ? candidates.find((candidate) => values.includes(candidate))
    : candidates[0];
}

function boundedSearchLimit(property: object | undefined, requested: number) {
  if (!Number.isFinite(requested)) throw new TwentyFirstToolContractError();
  const constraint = (property ?? {}) as {
    minimum?: unknown;
    maximum?: unknown;
  };
  const minimum =
    typeof constraint.minimum === "number" &&
    Number.isFinite(constraint.minimum)
      ? Math.ceil(constraint.minimum)
      : 1;
  const maximum =
    typeof constraint.maximum === "number" &&
    Number.isFinite(constraint.maximum)
      ? Math.floor(constraint.maximum)
      : 18;
  const lower = Math.max(1, minimum);
  const upper = Math.min(18, maximum);
  if (lower > upper) throw new TwentyFirstToolContractError();
  return Math.max(lower, Math.min(Math.trunc(requested), upper));
}

function advertisedJsonTypes(property: object | undefined) {
  if (!property) return new Set<string>();
  const candidate = property as {
    type?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
  };
  const types = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string") types.add(value);
    else if (Array.isArray(value)) value.forEach(add);
  };
  add(candidate.type);
  for (const variants of [candidate.anyOf, candidate.oneOf]) {
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (variant && typeof variant === "object") {
        add((variant as { type?: unknown }).type);
      }
    }
  }
  return types;
}

function assertAdvertisedPrimitive(
  property: object | undefined,
  value: string | number,
) {
  const types = advertisedJsonTypes(property);
  if (types.size === 0) return;
  const accepted =
    typeof value === "string"
      ? types.has("string")
      : types.has("number") ||
        (types.has("integer") && Number.isSafeInteger(value));
  const enumValues = Array.isArray(
    (property as { enum?: unknown } | undefined)?.enum,
  )
    ? (property as { enum: unknown[] }).enum
    : null;
  if (!accepted || (enumValues && !enumValues.includes(value))) {
    throw new TwentyFirstToolContractError();
  }
}

/**
 * Builds arguments from the server-advertised JSON schema. Only exact,
 * allowlisted semantic fields are populated; an incompatible schema fails
 * closed instead of guessing or calling another tool.
 */
export function buildTwentyFirstToolArguments(input: {
  operation: "search" | "get_component";
  tool: TwentyFirstAdvertisedTool;
  value: string | TwentyFirstProviderItemId;
  limit?: number;
  searchOptions?: Pick<TwentyFirstSearchRequest, "tag" | "sort">;
}) {
  const properties = input.tool.inputSchema.properties ?? {};
  const valueKey =
    input.operation === "search"
      ? findToolInputKey(input.tool, [
          "query",
          "searchQuery",
          "search_query",
          "q",
          "term",
          "keywords",
        ])
      : findToolInputKey(input.tool, [
          "id",
          "componentId",
          "component_id",
          "itemId",
          "item_id",
          "slug",
          "name",
        ]);
  if (!valueKey) {
    throw new TwentyFirstToolContractError();
  }
  if (input.operation === "search" && typeof input.value !== "string") {
    throw new TwentyFirstToolContractError();
  }
  assertAdvertisedPrimitive(properties[valueKey], input.value);
  const args: Record<string, unknown> = { [valueKey]: input.value };
  if (input.operation === "search") {
    const limitKey = findToolInputKey(input.tool, [
      "limit",
      "take",
      "pageSize",
      "page_size",
    ]);
    if (limitKey) {
      const limit = boundedSearchLimit(properties[limitKey], input.limit ?? 10);
      assertAdvertisedPrimitive(properties[limitKey], limit);
      args[limitKey] = limit;
    }
    const typeKey = findToolInputKey(input.tool, ["type", "kind"]);
    if (typeKey) {
      const typeValue = compatibleEnumValue(properties[typeKey], [
        "component",
        "components",
        "c",
      ]);
      if (!typeValue) throw new TwentyFirstToolContractError();
      assertAdvertisedPrimitive(properties[typeKey], typeValue);
      args[typeKey] = typeValue;
    }
    for (const [semanticKey, requested] of [
      ["tag", input.searchOptions?.tag],
      ["sort", input.searchOptions?.sort],
    ] as const) {
      if (!requested) continue;
      const advertisedKey = findToolInputKey(input.tool, [semanticKey]);
      if (!advertisedKey) continue;
      const property = properties[advertisedKey];
      const declaredEnum = Array.isArray(
        (property as { enum?: unknown } | undefined)?.enum,
      )
        ? (property as { enum: unknown[] }).enum
        : null;
      if (declaredEnum && !declaredEnum.includes(requested)) continue;
      assertAdvertisedPrimitive(property, requested);
      args[advertisedKey] = requested;
    }
  }
  const required = new Set(input.tool.inputSchema.required ?? []);
  const missingRequired = [...required].filter(
    (key) => !Object.prototype.hasOwnProperty.call(args, key),
  );
  if (missingRequired.length > 0) {
    throw new TwentyFirstToolContractError();
  }
  return args;
}

function parseToolTextPayload(text: string) {
  const value = text.trim();
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > TWENTY_FIRST_MAX_RESPONSE_BYTES
  ) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function resultsProjection(
  value: unknown,
  depth = 0,
): { results: unknown[] } | null {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { results?: unknown }).results)
  ) {
    return { results: (value as { results: unknown[] }).results };
  }
  if (
    depth < 4 &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const record = value as Record<string, unknown>;
    for (const key of [
      "data",
      "result",
      "payload",
      "output",
      "structuredContent",
    ]) {
      const nested = resultsProjection(record[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** Returns the provider payload only to the current bounded request. */
export function projectTwentyFirstToolPayload(result: Record<string, unknown>) {
  const structuredResults = resultsProjection(result.structuredContent);
  if (structuredResults) return structuredResults;
  const textItems = Array.isArray(result.content)
    ? result.content.filter((item): item is { type: "text"; text: string } =>
        Boolean(
          item &&
            typeof item === "object" &&
            (item as { type?: unknown }).type === "text" &&
            typeof (item as { text?: unknown }).text === "string",
        ),
      )
    : [];
  const totalTextBytes = textItems.reduce(
    (sum, item) => sum + Buffer.byteLength(item.text, "utf8"),
    0,
  );
  const parsed =
    totalTextBytes <= TWENTY_FIRST_MAX_RESPONSE_BYTES
      ? textItems
          .map((item) => parseToolTextPayload(item.text))
          .filter((item) => item !== null)
      : [];
  const textResults = parsed.flatMap(
    (item) => resultsProjection(item)?.results ?? [],
  );
  if (textResults.length > 0) return { results: textResults };
  if (parsed.length === 1) return parsed[0];
  if (parsed.length > 1) return { items: parsed };
  return result.structuredContent &&
    typeof result.structuredContent === "object"
    ? result.structuredContent
    : {};
}

function toTwentyFirstConnectionError(error: unknown): AuthServiceError {
  if (error instanceof AuthServiceError) return error;
  if (
    error instanceof StreamableHTTPError &&
    (error.code === 401 || error.code === 403)
  ) {
    return new AuthServiceError(
      "INVALID_CREDENTIAL",
      "21st API Key 无效或已被撤销",
    );
  }
  return new AuthServiceError(
    "UPSTREAM_UNAVAILABLE",
    "21st 服务暂时不可用，请稍后重试",
  );
}

export function assertTwentyFirstJsonDepth(
  value: unknown,
  maxDepth = TWENTY_FIRST_MAX_JSON_DEPTH,
) {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > maxDepth) {
      throw new AuthServiceError(
        "UPSTREAM_UNAVAILABLE",
        "21st 服务返回的数据结构过深",
      );
    }
    if (!current.value || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

/**
 * A deliberately narrow MCP client. It only performs the MCP initialization
 * handshake and tools/list; credential validation never invokes a paid or
 * mutating provider tool.
 */
export class TwentyFirstClient {
  constructor(
    private readonly options: {
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      totalTimeoutMs?: number;
      maxResponseBytes?: number;
      maxHttpRetries?: number;
      maxRetryAfterMs?: number;
      sleep?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {}

  private createTransport(apiKey: string) {
    const timeoutMs = this.options.timeoutMs ?? TWENTY_FIRST_REQUEST_TIMEOUT_MS;
    return new StreamableHTTPClientTransport(
      new URL(TWENTY_FIRST_MCP_ENDPOINT),
      {
        requestInit: { headers: { "x-api-key": apiKey } },
        fetch: createBoundedFetch(
          this.options.fetchImpl ?? fetch,
          timeoutMs,
          this.options.maxResponseBytes ?? TWENTY_FIRST_MAX_RESPONSE_BYTES,
          {
            maxRetries: this.options.maxHttpRetries,
            maxRetryAfterMs: this.options.maxRetryAfterMs,
            sleep: this.options.sleep,
          },
        ),
        reconnectionOptions: {
          initialReconnectionDelay: 250,
          maxReconnectionDelay: 1_000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 0,
        },
      },
    );
  }

  private requestOptions(totalSignal: AbortSignal) {
    const timeoutMs = this.options.timeoutMs ?? TWENTY_FIRST_REQUEST_TIMEOUT_MS;
    return {
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
      signal: AbortSignal.any([totalSignal, AbortSignal.timeout(timeoutMs)]),
    } as const;
  }

  private async listAdvertisedTools(client: Client, totalSignal: AbortSignal) {
    const tools: TwentyFirstAdvertisedTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (
      let page = 0;
      page < TWENTY_FIRST_MAX_TOOL_PAGES &&
      tools.length < TWENTY_FIRST_MAX_TOOLS;
      page += 1
    ) {
      const listed = await client.listTools(
        cursor ? { cursor } : {},
        this.requestOptions(totalSignal),
      );
      assertTwentyFirstJsonDepth(listed);
      tools.push(
        ...(listed.tools.slice(
          0,
          TWENTY_FIRST_MAX_TOOLS - tools.length,
        ) as TwentyFirstAdvertisedTool[]),
      );
      const next =
        typeof listed.nextCursor === "string" && listed.nextCursor.trim()
          ? listed.nextCursor
          : undefined;
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return tools;
  }

  async inspectCapabilities(
    apiKey: string,
  ): Promise<TwentyFirstConnectionResult> {
    const value = validateTwentyFirstApiKeyInput(apiKey);
    const timeoutMs = this.options.timeoutMs ?? TWENTY_FIRST_REQUEST_TIMEOUT_MS;
    const client = new Client(
      { name: "frontmind-dashboard", version: "1.1.0" },
      { capabilities: {} },
    );
    const transport = this.createTransport(value);
    try {
      const totalSignal = AbortSignal.timeout(timeoutMs);
      await client.connect(transport, this.requestOptions(totalSignal));
      const tools = await this.listAdvertisedTools(client, totalSignal);
      const byName = new Map<string, TwentyFirstAdvertisedTool>();
      for (const tool of tools) {
        if (!byName.has(tool.name)) byName.set(tool.name, tool);
      }
      const search = byName.get("search");
      if (!search || search.annotations?.destructiveHint === true) {
        throw new AuthServiceError(
          "INVALID_CREDENTIAL",
          "当前 21st 连接缺少安全的 search 能力",
        );
      }
      const optionalCapability = (name: string) => {
        const tool = byName.get(name);
        return Boolean(tool && tool.annotations?.destructiveHint !== true);
      };
      const server = client.getServerVersion();
      return {
        ok: true,
        endpoint: TWENTY_FIRST_MCP_ENDPOINT,
        capabilities: {
          search: true,
          getComponent: optionalCapability("get_component"),
          getUsage: optionalCapability("get_usage"),
          getTheme: optionalCapability("get_theme"),
        },
        server: server ? { name: server.name, version: server.version } : null,
      };
    } catch (error) {
      throw toTwentyFirstConnectionError(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * Opens one bounded read-only MCP session. The callback can invoke only the
   * exact existing-catalog tools discovered from tools/list. Optional catalog
   * capabilities are exposed only when the server advertises them as
   * non-destructive. SiteOps workflow 2.5 requires get_component to retrieve
   * the source behind a candidate; immutable older workflows remain
   * search-preview based.
   */
  async withReadOnlySession<T>(
    apiKey: string,
    use: (session: TwentyFirstReadOnlySession) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const value = validateTwentyFirstApiKeyInput(apiKey);
    const totalTimeoutMs =
      this.options.totalTimeoutMs ?? TWENTY_FIRST_TOTAL_TIMEOUT_MS;
    const totalTimeout = AbortSignal.timeout(totalTimeoutMs);
    const totalSignal = options.signal
      ? AbortSignal.any([options.signal, totalTimeout])
      : totalTimeout;
    const client = new Client(
      { name: "frontmind-dashboard-siteops", version: "1.1.0" },
      { capabilities: {} },
    );
    const transport = this.createTransport(value);
    try {
      await client.connect(transport, this.requestOptions(totalSignal));
      const tools = await this.listAdvertisedTools(client, totalSignal);
      const byName = new Map<string, TwentyFirstAdvertisedTool>();
      for (const tool of tools) {
        if (!byName.has(tool.name)) byName.set(tool.name, tool);
      }
      const search = byName.get("search");
      const getComponent = byName.get("get_component");
      if (!search) {
        throw new AuthServiceError(
          "INVALID_CREDENTIAL",
          "当前 21st 连接缺少 search 能力",
        );
      }
      if (search.annotations?.destructiveHint === true) {
        throw new AuthServiceError(
          "UPSTREAM_UNAVAILABLE",
          "21st 只读工具声明异常",
        );
      }
      const safeGetComponent =
        getComponent?.annotations?.destructiveHint === true
          ? undefined
          : getComponent;
      const searchLimitKey = findToolInputKey(search, [
        "limit",
        "take",
        "pageSize",
        "page_size",
      ]);
      const effectiveSearchLimit = searchLimitKey
        ? boundedSearchLimit(
            search.inputSchema.properties?.[searchLimitKey],
            18,
          )
        : 18;
      const call = async (
        operation: "search" | "get_component",
        tool: TwentyFirstAdvertisedTool,
        argumentValue: string | TwentyFirstProviderItemId,
        limit?: number,
        searchOptions?: Pick<TwentyFirstSearchRequest, "tag" | "sort">,
      ) => {
        const args = buildTwentyFirstToolArguments({
          operation,
          tool,
          value: argumentValue,
          limit,
          searchOptions,
        });
        const result = await client.callTool(
          { name: tool.name, arguments: args },
          undefined,
          this.requestOptions(totalSignal),
        );
        assertTwentyFirstJsonDepth(result);
        if (result.isError === true) {
          throw new AuthServiceError(
            "UPSTREAM_UNAVAILABLE",
            "21st 目录查询暂时不可用",
          );
        }
        const payload = projectTwentyFirstToolPayload(
          result as Record<string, unknown>,
        );
        assertTwentyFirstJsonDepth(payload);
        return payload;
      };
      return await use({
        effectiveSearchLimit,
        search: (input) => {
          if (input.type !== "component") {
            throw new TwentyFirstToolContractError();
          }
          return call("search", search, input.query, input.limit, {
            tag: input.tag,
            sort: input.sort,
          });
        },
        ...(safeGetComponent
          ? {
              getComponent: (providerItemId: TwentyFirstProviderItemId) =>
                call("get_component", safeGetComponent, providerItemId),
            }
          : {}),
      });
    } catch (error) {
      throw toTwentyFirstConnectionError(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

function toCredentialStatus(
  credential?: PresalesApiCredential | null,
  capabilities?: TwentyFirstCapabilities,
): TwentyFirstCredentialStatus {
  const visible = Boolean(credential && credential.status !== "deleted");
  const configured = Boolean(
    credential &&
      credential.status === "active" &&
      credential.validationStatus === "verified",
  );
  const status =
    !credential || credential.status === "deleted"
      ? null
      : credential.validationStatus === "invalid"
        ? "invalid"
        : credential.status;
  return {
    configured,
    revocationPending: Boolean(
      credential &&
        credential.status !== "deleted" &&
        credential.validationStatus === "invalid",
    ),
    fingerprint: visible ? (credential?.fingerprint ?? null) : null,
    status,
    version: visible ? (credential?.version ?? null) : null,
    verifiedAt: visible ? (credential?.verifiedAt?.getTime() ?? null) : null,
    updatedAt: visible ? (credential?.updatedAt?.getTime() ?? null) : null,
    capabilities:
      capabilities ??
      (configured
        ? {
            search: true,
            getComponent: false,
            getUsage: null,
            getTheme: null,
          }
        : {
            search: false,
            getComponent: false,
            getUsage: null,
            getTheme: null,
          }),
  };
}

export async function getTwentyFirstCredentialStatus() {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  return toCredentialStatus(rows[0]);
}

export async function replaceTwentyFirstApiCredential(
  actorUserId: number,
  apiKey: string,
  inspect: (apiKey: string) => Promise<TwentyFirstConnectionResult> = (value) =>
    new TwentyFirstClient().inspectCapabilities(value),
) {
  const value = validateTwentyFirstApiKeyInput(apiKey);
  const connection = await inspect(value);
  const db = await requireDb();
  const existingRows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
        eq(presalesApiCredentials.status, "active"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  const existing = existingRows[0];
  const credentialId = randomUUID();
  const encrypted = encryptTwentyFirstApiKey(credentialId, value);
  const fingerprint = getApiKeyFingerprint(value);
  const now = new Date();

  const inserted = await db.transaction(async (tx) => {
    const active = await tx
      .select({ id: presalesApiCredentials.id })
      .from(presalesApiCredentials)
      .where(
        and(
          eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
          eq(presalesApiCredentials.status, "active"),
        ),
      )
      .orderBy(desc(presalesApiCredentials.version))
      .limit(1)
      .for("update");
    if ((active[0]?.id ?? null) !== (existing?.id ?? null)) {
      throw new AuthServiceError(
        "CONFLICT",
        "21st API Key 状态已变化，请刷新后重试。",
      );
    }
    const latest = await tx
      .select()
      .from(presalesApiCredentials)
      .where(eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT))
      .orderBy(desc(presalesApiCredentials.version))
      .limit(1)
      .for("update");
    const nextVersion = (latest[0]?.version ?? 0) + 1;
    await tx
      .update(presalesApiCredentials)
      .set({ status: "retired", retiredAt: now })
      .where(
        and(
          eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
          eq(presalesApiCredentials.status, "active"),
        ),
      );
    const credential = {
      id: credentialId,
      slot: TWENTY_FIRST_CREDENTIAL_SLOT,
      version: nextVersion,
      ...encrypted,
      fingerprint,
      status: "active" as const,
      validationStatus: "verified" as const,
      createdByUserId: actorUserId,
      verifiedAt: now,
      retiredAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(presalesApiCredentials).values(credential);
    return credential;
  });
  return toCredentialStatus(inserted, connection.capabilities);
}

export async function getActiveTwentyFirstCredential() {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
        eq(presalesApiCredentials.status, "active"),
        eq(presalesApiCredentials.validationStatus, "verified"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  const credential = rows[0];
  if (!credential) return null;
  return {
    id: credential.id,
    version: credential.version,
    fingerprint: credential.fingerprint,
    apiKey: decryptTwentyFirstApiKey(credential),
  };
}

export async function getTwentyFirstCredentialById(credentialId: string) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.id, credentialId),
        eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .limit(1);
  const credential = rows[0];
  if (!credential) return null;
  return {
    id: credential.id,
    version: credential.version,
    fingerprint: credential.fingerprint,
    apiKey: decryptTwentyFirstApiKey(credential),
  };
}

export async function testTwentyFirstApiCredential(
  apiKey?: string,
  inspect: (apiKey: string) => Promise<TwentyFirstConnectionResult> = (value) =>
    new TwentyFirstClient().inspectCapabilities(value),
) {
  const credential = apiKey ? null : await getActiveTwentyFirstCredential();
  const value = apiKey?.trim() || credential?.apiKey;
  if (!value) {
    throw new AuthServiceError("NOT_FOUND", "请先配置 21st API Key");
  }
  return inspect(value);
}

/**
 * SiteOps supplies a probe backed by its operation table. Keeping the probe
 * injectable avoids coupling the service-wide credential store to SiteOps'
 * lease/state implementation while still making deletion fail closed.
 */
export async function deleteTwentyFirstApiCredential(
  hasActiveConsumers: TwentyFirstActiveConsumerProbe = hasActiveTwentyFirstConsumers,
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const remove = async (tx: any) => {
    const retainedRows = await tx
      .select({
        id: presalesApiCredentials.id,
        status: presalesApiCredentials.status,
      })
      .from(presalesApiCredentials)
      .where(
        and(
          eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
          ne(presalesApiCredentials.status, "deleted"),
        ),
      )
      .for("update");
    if (retainedRows.length === 0) {
      return { deleted: false, pending: false } as const;
    }
    const retainedIds = retainedRows.map((row: { id: string }) => row.id);
    const now = new Date();
    if (await hasActiveConsumers(retainedIds, tx)) {
      await tx
        .update(presalesApiCredentials)
        .set({ validationStatus: "invalid", updatedAt: now })
        .where(
          and(
            eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
            ne(presalesApiCredentials.status, "deleted"),
            inArray(presalesApiCredentials.id, retainedIds),
          ),
        );
      return { deleted: false, pending: true } as const;
    }
    await tx
      .update(presalesApiCredentials)
      .set({
        status: "deleted",
        validationStatus: "unverified",
        deletedAt: now,
        encryptedKey: randomBytes(32).toString("base64"),
        encryptionIv: randomBytes(12).toString("base64"),
        encryptionAuthTag: randomBytes(16).toString("base64"),
      })
      .where(
        and(
          eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
          ne(presalesApiCredentials.status, "deleted"),
          inArray(presalesApiCredentials.id, retainedIds),
        ),
      );
    return { deleted: true, pending: false } as const;
  };
  if (executor) return remove(db);
  return db.transaction(remove);
}

/**
 * Completes an already requested revocation after every frozen visual task is
 * terminal. Only versions marked invalid by the prior delete request are
 * shredded, so a newer replacement credential can never be removed here.
 */
export async function finalizePendingTwentyFirstCredentialRevocations(
  hasActiveConsumers: TwentyFirstActiveConsumerProbe = hasActiveTwentyFirstConsumers,
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const finalize = async (tx: any) => {
    const rows = await tx
      .select({ id: presalesApiCredentials.id })
      .from(presalesApiCredentials)
      .where(
        and(
          eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
          eq(presalesApiCredentials.validationStatus, "invalid"),
          ne(presalesApiCredentials.status, "deleted"),
        ),
      )
      .for("update");
    const ids = rows.map((row: { id: string }) => row.id);
    if (ids.length === 0) return { deleted: 0, pending: false };
    if (await hasActiveConsumers(ids, tx)) {
      return { deleted: 0, pending: true };
    }
    const now = new Date();
    await tx
      .update(presalesApiCredentials)
      .set({
        status: "deleted",
        validationStatus: "unverified",
        deletedAt: now,
        encryptedKey: randomBytes(32).toString("base64"),
        encryptionIv: randomBytes(12).toString("base64"),
        encryptionAuthTag: randomBytes(16).toString("base64"),
        updatedAt: now,
      })
      .where(
        and(
          eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
          inArray(presalesApiCredentials.id, ids),
        ),
      );
    return { deleted: ids.length, pending: false };
  };
  if (executor) return finalize(db);
  return db.transaction(finalize);
}
