import axios from "axios";

export const UPSTREAM_FILE_METADATA_TIMEOUT_MS = 10_000;
export const UPSTREAM_FILE_READINESS_RETRY_AFTER_MS = 3_000;

const READINESS_BACKOFF_MS = [500, 1_000, 2_000, 3_000] as const;

export type UpstreamFileIdentity = {
  fileId: string;
  filename: string;
};

export type UpstreamFileReadiness = UpstreamFileIdentity & {
  state: "pending" | "uploaded";
  status: "pending" | "uploaded";
  checkedAt: number;
};

export type UpstreamFilesReadiness = {
  files: UpstreamFileReadiness[];
  ready: UpstreamFileReadiness[];
  pending: UpstreamFileReadiness[];
};

export type UpstreamFileReadinessErrorCode =
  | "UPSTREAM_FILE_METADATA_UNAVAILABLE"
  | "UPSTREAM_FILE_METADATA_INVALID"
  | "UPSTREAM_FILE_IDENTITY_MISMATCH"
  | "UPSTREAM_FILE_UNUSABLE";

export class UpstreamFileReadinessError extends Error {
  constructor(
    readonly code: UpstreamFileReadinessErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
    readonly providerStatus: string | null = null,
  ) {
    super(message);
    this.name = "UpstreamFileReadinessError";
  }
}

type ReadinessRequest = {
  baseUrl: string;
  apiKey: string;
  file: UpstreamFileIdentity;
  signal?: AbortSignal;
  timeoutMs?: number;
  filenamePolicy?: "exact" | "provider_authoritative";
};

type FilesReadinessRequest = Omit<ReadinessRequest, "file"> & {
  files: UpstreamFileIdentity[];
};

function officialFileMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.filename !== "string" ||
    !record.filename.trim() ||
    Buffer.byteLength(record.filename, "utf8") > 512 ||
    typeof record.status !== "string" ||
    !record.status
  ) {
    return null;
  }
  return {
    id: record.id,
    filename: record.filename,
    status: record.status.trim().toLowerCase(),
  };
}

function isTransientStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Read the provider's official v1 file metadata shape. This request must never
 * be treated as a source of an upload capability; only id/filename/status are
 * consumed and only API_KEY authentication is sent.
 */
export async function checkUpstreamFileReadiness(
  input: ReadinessRequest,
): Promise<UpstreamFileReadiness> {
  let response;
  try {
    response = await axios.get(
      `${input.baseUrl.replace(/\/$/u, "")}/v1/files/${encodeURIComponent(input.file.fileId)}`,
      {
        headers: {
          API_KEY: input.apiKey,
          Accept: "application/json",
        },
        timeout: input.timeoutMs ?? UPSTREAM_FILE_METADATA_TIMEOUT_MS,
        maxRedirects: 0,
        maxContentLength: 1024 * 1024,
        signal: input.signal,
        validateStatus: () => true,
      },
    );
  } catch (error) {
    if (
      input.signal?.aborted ||
      (error as { code?: unknown } | null)?.code === "ERR_CANCELED"
    ) {
      throw error;
    }
    throw new UpstreamFileReadinessError(
      "UPSTREAM_FILE_METADATA_UNAVAILABLE",
      "Upstream file metadata is temporarily unavailable",
      true,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    if (isTransientStatus(response.status)) {
      throw new UpstreamFileReadinessError(
        "UPSTREAM_FILE_METADATA_UNAVAILABLE",
        "Upstream file metadata is temporarily unavailable",
        true,
        response.status,
      );
    }
    throw new UpstreamFileReadinessError(
      response.status === 404
        ? "UPSTREAM_FILE_UNUSABLE"
        : "UPSTREAM_FILE_METADATA_INVALID",
      response.status === 404
        ? "Upstream file no longer exists"
        : "Upstream file metadata request was rejected",
      false,
      response.status,
      response.status === 404 ? "deleted" : null,
    );
  }

  const metadata = officialFileMetadata(response.data);
  if (!metadata) {
    throw new UpstreamFileReadinessError(
      "UPSTREAM_FILE_METADATA_INVALID",
      "Upstream file metadata has an invalid shape",
      false,
      response.status,
    );
  }
  if (
    metadata.id !== input.file.fileId ||
    (input.filenamePolicy !== "provider_authoritative" &&
      metadata.filename !== input.file.filename)
  ) {
    throw new UpstreamFileReadinessError(
      "UPSTREAM_FILE_IDENTITY_MISMATCH",
      "Upstream file identity does not match the requested file",
      false,
      response.status,
      metadata.status,
    );
  }
  if (metadata.status === "pending" || metadata.status === "uploaded") {
    return {
      fileId: metadata.id,
      filename: metadata.filename,
      state: metadata.status,
      status: metadata.status,
      checkedAt: Date.now(),
    };
  }
  throw new UpstreamFileReadinessError(
    metadata.status === "deleted" || metadata.status === "error"
      ? "UPSTREAM_FILE_UNUSABLE"
      : "UPSTREAM_FILE_METADATA_INVALID",
    "Upstream file is not usable by a task",
    false,
    response.status,
    metadata.status,
  );
}

export async function checkUpstreamFilesReadiness(
  input: FilesReadinessRequest,
): Promise<UpstreamFilesReadiness> {
  const files = await Promise.all(
    input.files.map((file) =>
      checkUpstreamFileReadiness({
        ...input,
        file,
      }),
    ),
  );
  return {
    files,
    ready: files.filter((file) => file.state === "uploaded"),
    pending: files.filter((file) => file.state === "pending"),
  };
}

function readinessDelay(attempt: number, random: () => number) {
  const base =
    READINESS_BACKOFF_MS[Math.min(attempt, READINESS_BACKOFF_MS.length - 1)];
  return Math.max(1, Math.round(base * (0.8 + random() * 0.4)));
}

function abortableSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Upstream readiness wait cancelled"));
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Upstream readiness wait cancelled"));
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForUpstreamFilesReady(
  input: FilesReadinessRequest & {
    /** Maximum elapsed wait, including metadata requests. */
    deadlineMs?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
  },
): Promise<UpstreamFilesReadiness> {
  const startedAt = Date.now();
  const deadlineMs = Math.max(0, input.deadlineMs ?? 5 * 60_000);
  const sleep = input.sleep ?? abortableSleep;
  const random = input.random ?? Math.random;
  let attempt = 0;
  let lastResult: UpstreamFilesReadiness | null = null;
  let lastTransientError: UpstreamFileReadinessError | null = null;

  while (true) {
    try {
      lastResult = await checkUpstreamFilesReadiness(input);
      lastTransientError = null;
      if (lastResult.pending.length === 0) return lastResult;
    } catch (error) {
      if (!(error instanceof UpstreamFileReadinessError) || !error.retryable) {
        throw error;
      }
      lastTransientError = error;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= deadlineMs) {
      if (lastTransientError) throw lastTransientError;
      return lastResult!;
    }
    const delay = Math.min(
      readinessDelay(attempt, random),
      Math.max(0, deadlineMs - elapsed),
    );
    attempt += 1;
    await sleep(delay, input.signal);
  }
}
