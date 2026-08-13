import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

export type ResetPollutionUploadProof = {
  intentCount: number;
  stateSha256: string;
  localOnlyItems: Array<{
    intentIdSha256: string;
    operationIdSha256: string;
    ordinal: number;
    total: number;
    state: string;
    sizeBytes: number | null;
    sha256: string | null;
  }>;
};

type ProvenIntent = {
  directory: string;
  operationIndex: string;
  state: JsonRecord;
};

type InternalProof = ResetPollutionUploadProof & {
  intents: ProvenIntent[];
  resumeIndex: string;
  retired: boolean;
};

function assetRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

function storageKey(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function intentRoot() {
  return path.join(assetRoot(), "managed-upload-intents");
}

function operationIndexPath(input: {
  userId: number;
  projectAssignmentId: string | null;
  operationId: string;
}) {
  const key = storageKey(
    JSON.stringify([
      input.userId,
      input.projectAssignmentId,
      input.operationId,
    ]),
  );
  return path.join(intentRoot(), "by-operation", `${key}.json`);
}

function resumeIndexPath(input: {
  userId: number;
  projectAssignmentId: string | null;
  conversationId: string;
  turnId: string;
}) {
  const key = storageKey(
    JSON.stringify([
      input.userId,
      input.projectAssignmentId,
      "knowledge_base",
      input.conversationId,
      input.turnId,
    ]),
  );
  return path.join(intentRoot(), "by-resume-scope", `${key}.json`);
}

async function readJson(target: string) {
  return JSON.parse(await fs.readFile(target, "utf8")) as JsonRecord;
}

async function writeJsonAtomic(target: string, value: unknown) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function safeIdentifier(value: unknown, max: number) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= max &&
    !/[\0\r\n]/u.test(value)
  );
}

function safeManifestState(value: JsonRecord) {
  const scope = value.resumeScope as JsonRecord;
  return {
    intentId: value.intentId,
    operationId: value.operationId,
    requestHash: value.requestHash,
    batchId: value.batchId,
    ordinal: value.ordinal,
    total: value.total,
    revision: value.revision,
    state: value.state,
    phase: value.phase,
    declaredSizeBytes: value.declaredSizeBytes,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
    clientRequestId: scope.clientRequestId,
    createdAt: value.createdAt,
    sealedAt: value.sealedAt,
    updatedAt: value.updatedAt,
  };
}

function isStrictLocalOnlyState(manifest: JsonRecord) {
  if (
    manifest.state === "awaiting_browser" &&
    manifest.phase === null &&
    manifest.sizeBytes === null &&
    manifest.sha256 === null &&
    manifest.sealedAt === null
  ) {
    return true;
  }
  if (
    manifest.state === "receiving" &&
    manifest.phase === "receiving" &&
    manifest.sizeBytes === null &&
    manifest.sha256 === null &&
    manifest.sealedAt === null
  ) {
    return true;
  }
  return (
    manifest.state === "sealed" &&
    manifest.phase === "sealed" &&
    manifest.sizeBytes === manifest.declaredSizeBytes &&
    Number.isSafeInteger(Number(manifest.sizeBytes)) &&
    Number(manifest.sizeBytes) > 0 &&
    typeof manifest.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(manifest.sha256) &&
    typeof manifest.sealedAt === "string" &&
    Number.isFinite(Date.parse(manifest.sealedAt))
  );
}

async function inspectInternal(input: {
  userId: number;
  projectAssignmentId: string | null;
  conversationId: string;
  turnId: string;
  clientRequestId: string;
}): Promise<InternalProof> {
  const root = intentRoot();
  const resumeIndex = resumeIndexPath(input);
  const indexed = await readJson(resumeIndex).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (indexed?.state === "retired") {
    const localOnlyItems = Array.isArray(indexed.localOnlyItems)
      ? indexed.localOnlyItems
      : null;
    if (
      indexed.schemaVersion !== 1 ||
      !Number.isSafeInteger(indexed.retiredCount) ||
      Number(indexed.retiredCount) < 0 ||
      typeof indexed.stateSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(indexed.stateSha256) ||
      !localOnlyItems ||
      localOnlyItems.length !== Number(indexed.retiredCount) ||
      localOnlyItems.some((item) => {
        const value = item as JsonRecord;
        return (
          typeof value.intentIdSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(value.intentIdSha256) ||
          typeof value.operationIdSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(value.operationIdSha256) ||
          !Number.isSafeInteger(value.ordinal) ||
          !Number.isSafeInteger(value.total) ||
          !["awaiting_browser", "receiving", "sealed"].includes(
            String(value.state),
          ) ||
          !(
            (value.state === "sealed" &&
              Number.isSafeInteger(value.sizeBytes) &&
              Number(value.sizeBytes) > 0 &&
              typeof value.sha256 === "string" &&
              /^[a-f0-9]{64}$/u.test(value.sha256)) ||
            (value.state !== "sealed" &&
              value.sizeBytes === null &&
              value.sha256 === null)
          )
        );
      })
    ) {
      throw new Error("KB_RESET_POLLUTION_UPLOAD_SCOPE_INDEX_INVALID");
    }
    return {
      intentCount: Number(indexed.retiredCount),
      stateSha256: indexed.stateSha256,
      localOnlyItems:
        localOnlyItems as ResetPollutionUploadProof["localOnlyItems"],
      intents: [],
      resumeIndex,
      retired: true,
    };
  }
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  const intents: ProvenIntent[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      ["by-operation", "by-resume-scope", "deletion-fences"].includes(
        entry.name,
      )
    ) {
      continue;
    }
    const directory = path.join(root, entry.name);
    const manifest = await readJson(path.join(directory, "manifest.json"));
    const scope = manifest.resumeScope as JsonRecord | undefined;
    if (
      scope?.kind !== "knowledge_base" ||
      scope.conversationId !== input.conversationId ||
      scope.turnId !== input.turnId
    ) {
      continue;
    }
    const provider = Array.isArray(manifest.provider) ? manifest.provider : [];
    if (
      manifest.schemaVersion !== 2 ||
      manifest.userId !== input.userId ||
      (manifest.projectAssignmentId ?? null) !== input.projectAssignmentId ||
      scope.clientRequestId !== input.clientRequestId ||
      !safeIdentifier(manifest.intentId, 255) ||
      !safeIdentifier(manifest.operationId, 255) ||
      !safeIdentifier(manifest.requestHash, 64) ||
      manifest.providerGeneration !== 0 ||
      provider.length !== 0 ||
      manifest.receipt !== null ||
      !isStrictLocalOnlyState(manifest) ||
      manifest.leaseOwner !== null ||
      manifest.leaseExpiresAt !== null ||
      manifest.completedAt !== null ||
      manifest.safeErrorCode !== null ||
      manifest.deletedAt !== null ||
      entry.name !== storageKey(String(manifest.intentId))
    ) {
      throw new Error("KB_RESET_POLLUTION_UPLOAD_NOT_NEVER_SENT");
    }
    const operationIndex = operationIndexPath({
      userId: input.userId,
      projectAssignmentId: input.projectAssignmentId,
      operationId: String(manifest.operationId),
    });
    const index = await readJson(operationIndex);
    if (
      index.schemaVersion !== 1 ||
      index.intentId !== manifest.intentId ||
      index.requestHash !== manifest.requestHash ||
      index.state === "retired"
    ) {
      throw new Error("KB_RESET_POLLUTION_UPLOAD_INDEX_INVALID");
    }
    intents.push({
      directory,
      operationIndex,
      state: safeManifestState(manifest),
    });
  }
  intents.sort(
    (left, right) => Number(left.state.ordinal) - Number(right.state.ordinal),
  );
  const indexedIds = Array.isArray(indexed?.intentIds) ? indexed.intentIds : [];
  const provenIds = intents.map((intent) => intent.state.intentId);
  if (
    indexed &&
    (indexed.schemaVersion !== 1 ||
      JSON.stringify([...indexedIds].sort()) !==
        JSON.stringify([...provenIds].sort()))
  ) {
    throw new Error("KB_RESET_POLLUTION_UPLOAD_SCOPE_INDEX_INVALID");
  }
  const stateSha256 = createHash("sha256")
    .update(JSON.stringify(intents.map((intent) => intent.state)), "utf8")
    .digest("hex");
  return {
    intentCount: intents.length,
    stateSha256,
    localOnlyItems: intents.map((intent) => ({
      intentIdSha256: storageKey(String(intent.state.intentId)),
      operationIdSha256: storageKey(String(intent.state.operationId)),
      ordinal: Number(intent.state.ordinal),
      total: Number(intent.state.total),
      state: String(intent.state.state),
      sizeBytes:
        intent.state.sizeBytes === null ? null : Number(intent.state.sizeBytes),
      sha256:
        typeof intent.state.sha256 === "string" ? intent.state.sha256 : null,
    })),
    intents,
    resumeIndex,
    retired: false,
  };
}

export async function inspectResetPollutionUploadIntents(input: {
  userId: number;
  projectAssignmentId: string | null;
  conversationId: string;
  turnId: string;
  clientRequestId: string;
}): Promise<ResetPollutionUploadProof> {
  const proof = await inspectInternal(input);
  return {
    intentCount: proof.intentCount,
    stateSha256: proof.stateSha256,
    localOnlyItems: proof.localOnlyItems,
  };
}

export async function retireResetPollutionUploadIntents(input: {
  userId: number;
  projectAssignmentId: string | null;
  conversationId: string;
  turnId: string;
  clientRequestId: string;
  expectedStateSha256: string;
}) {
  const proof = await inspectInternal(input);
  if (proof.stateSha256 !== input.expectedStateSha256) {
    throw new Error("KB_RESET_POLLUTION_UPLOAD_STATE_CHANGED");
  }
  if (proof.retired) return { retiredCount: proof.intentCount };
  const retiredAt = new Date().toISOString();
  // The owning application is stopped for this one-shot maintenance command.
  // Retired indexes are written before bytes disappear, so a crash can never
  // make an old browser reservation executable again.
  for (const intent of proof.intents) {
    await writeJsonAtomic(intent.operationIndex, {
      schemaVersion: 1,
      state: "retired",
      retiredAt,
    });
  }
  await writeJsonAtomic(proof.resumeIndex, {
    schemaVersion: 1,
    state: "retired",
    intentIds: [],
    retiredCount: proof.intentCount,
    stateSha256: proof.stateSha256,
    localOnlyItems: proof.localOnlyItems,
    retiredAt,
  });
  for (const intent of proof.intents) {
    await fs.rm(intent.directory, { recursive: true, force: true });
  }
  return { retiredCount: proof.intentCount };
}

const BUILD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function removeResetPollutionRetainedSources(input: {
  userId: number;
  buildId: string;
  generation: number;
  sources: Array<{
    localStorageKey: string;
    contentSha256: string;
    sizeBytes: number;
  }>;
}) {
  if (
    !Number.isSafeInteger(input.userId) ||
    input.userId < 1 ||
    !BUILD_ID.test(input.buildId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1
  ) {
    throw new Error("KB_RESET_POLLUTION_LOCAL_SOURCE_COORDINATE_INVALID");
  }
  const root = assetRoot();
  const unique = new Map(
    input.sources.map((source) => [source.localStorageKey, source]),
  );
  const expectedGenerationRoot = [
    "knowledge-base",
    "build-sources",
    String(input.userId),
    input.buildId.toLowerCase(),
    `g${input.generation}`,
  ].join("/");
  for (const source of unique.values()) {
    const expectedKey = [
      "knowledge-base",
      "build-sources",
      String(input.userId),
      input.buildId.toLowerCase(),
      `g${input.generation}`,
      `${source.contentSha256}.bin`,
    ].join("/");
    if (
      source.localStorageKey !== expectedKey ||
      !/^[a-f0-9]{64}$/u.test(source.contentSha256) ||
      !Number.isSafeInteger(source.sizeBytes) ||
      source.sizeBytes < 1
    ) {
      throw new Error("KB_RESET_POLLUTION_LOCAL_SOURCE_SCOPE_INVALID");
    }
    const target = path.resolve(root, ...expectedKey.split("/"));
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error("KB_RESET_POLLUTION_LOCAL_SOURCE_SCOPE_INVALID");
    }
    let current = root;
    let missing = false;
    for (const segment of expectedKey.split("/")) {
      current = path.join(current, segment);
      const metadata = await fs.lstat(current).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!metadata) {
        missing = true;
        break;
      }
      if (metadata.isSymbolicLink()) {
        throw new Error("KB_RESET_POLLUTION_LOCAL_SOURCE_SCOPE_INVALID");
      }
    }
    if (missing) continue;
    const bytes = await fs.readFile(target);
    if (
      bytes.length !== source.sizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== source.contentSha256
    ) {
      throw new Error("KB_RESET_POLLUTION_LOCAL_SOURCE_INTEGRITY_MISMATCH");
    }
    await fs.rm(target, { force: true });
  }
  const generationDirectory = path.resolve(
    root,
    ...expectedGenerationRoot.split("/"),
  );
  const remaining = await fs.readdir(generationDirectory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  if (remaining.length === 0) {
    await fs.rmdir(generationDirectory).catch((error) => {
      if (
        !["ENOENT", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code || "",
        )
      ) {
        throw error;
      }
    });
  }
  return { removedOrMissingCount: unique.size };
}
