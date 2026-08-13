import type { Connection, RowDataPacket } from "mysql2/promise";
import mysql from "mysql2/promise";

import {
  executeKnowledgeBaseIncidentRepairFromSignedImageMaintenance,
  previewKnowledgeBaseIncidentRepairFromSignedImageMaintenance,
} from "./knowledge-base-incident-repair";
import {
  executeResetPollutionCleanup,
  previewResetPollutionCleanup,
} from "./knowledge-base-reset-pollution-cleanup";
import { serializeResetPollutionCleanupCliResult } from "./knowledge-base-reset-pollution-cleanup-cli-core";
import {
  assertKnowledgeBaseIncidentRepairCliRuntime,
  knowledgeBaseIncidentRepairCliApplyResult,
  knowledgeBaseIncidentRepairCliFailureResult,
  KNOWLEDGE_BASE_INCIDENT_REPAIR_CLI_LOCK_NAME,
  knowledgeBaseIncidentRepairCliPreviewResult,
  parseKnowledgeBaseIncidentRepairCliArgs,
  serializeKnowledgeBaseIncidentRepairCliResult,
  type KnowledgeBaseIncidentRepairCliCommand,
  type KnowledgeBaseIncidentRepairCliResult,
} from "./knowledge-base-incident-repair-cli-core";
import { validateReleaseRuntimeEnvironment } from "./_core/release-channel-adapter";

declare const __FRONTMIND_BUILD_SHA__: string | undefined;
declare const __FRONTMIND_RELEASE_CHANNEL__: string | undefined;

const LOOPBACK_READINESS_URL = "http://127.0.0.1:3001/readyz";

function fail(code: string): never {
  throw new Error(`KB_INCIDENT_REPAIR_CLI_${code}`);
}

function installOutputSilencer() {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  console.log = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  console.debug = () => undefined;
  return (value: string) => stdoutWrite(value);
}

async function readiness() {
  let response: Response;
  try {
    response = await fetch(LOOPBACK_READINESS_URL, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail("READINESS_UNAVAILABLE");
  }
  if (response.status !== 200) fail("READINESS_UNAVAILABLE");
  try {
    return await response.json();
  } catch {
    fail("READINESS_INVALID");
  }
}

async function acquireMaintenanceLock(): Promise<Connection> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL_REQUIRED");
  const connection = await mysql
    .createConnection(databaseUrl)
    .catch(() => fail("DATABASE_LOCK_UNAVAILABLE"));
  const [rows] = await connection
    .execute<
      RowDataPacket[]
    >("SELECT GET_LOCK(?, 0) AS acquired", [KNOWLEDGE_BASE_INCIDENT_REPAIR_CLI_LOCK_NAME])
    .catch(async () => {
      await connection.end().catch(() => undefined);
      fail("DATABASE_LOCK_UNAVAILABLE");
    });
  if (Number(rows[0]?.acquired) !== 1) {
    await connection.end().catch(() => undefined);
    fail("ALREADY_RUNNING");
  }
  return connection;
}

async function releaseMaintenanceLock(connection: Connection | null) {
  if (!connection) return true;
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT RELEASE_LOCK(?) AS released",
      [KNOWLEDGE_BASE_INCIDENT_REPAIR_CLI_LOCK_NAME],
    );
    await connection.end();
    return Number(rows[0]?.released) === 1;
  } catch {
    await connection.end().catch(() => undefined);
    return false;
  }
}

async function execute(command: KnowledgeBaseIncidentRepairCliCommand) {
  if (command.mode === "reset-pollution-preview") {
    const value = await previewResetPollutionCleanup(command);
    return { mode: command.mode, value } as const;
  }
  if (command.mode === "reset-pollution-apply") {
    const value = await executeResetPollutionCleanup(command);
    return { mode: command.mode, value } as const;
  }
  if (command.mode === "preview") {
    const preview =
      await previewKnowledgeBaseIncidentRepairFromSignedImageMaintenance(
        command,
      );
    if (!preview) fail("BUILD_NOT_FOUND");
    return { mode: command.mode, value: preview } as const;
  }
  const result =
    await executeKnowledgeBaseIncidentRepairFromSignedImageMaintenance(command);
  return { mode: command.mode, value: result } as const;
}

async function main() {
  const writeOutput = installOutputSilencer();
  const compiledBuildSha =
    typeof __FRONTMIND_BUILD_SHA__ === "string"
      ? __FRONTMIND_BUILD_SHA__.trim().toLowerCase()
      : "";
  const compiledReleaseChannel =
    typeof __FRONTMIND_RELEASE_CHANNEL__ === "string"
      ? __FRONTMIND_RELEASE_CHANNEL__.trim().toLowerCase()
      : "";
  let command: KnowledgeBaseIncidentRepairCliCommand | null = null;
  let connection: Connection | null = null;
  let result: KnowledgeBaseIncidentRepairCliResult;
  try {
    command = parseKnowledgeBaseIncidentRepairCliArgs(process.argv.slice(2));
    const resetPollutionMode =
      command.mode === "reset-pollution-preview" ||
      command.mode === "reset-pollution-apply";
    if (
      resetPollutionMode &&
      process.env.FRONTMIND_RESET_POLLUTION_OFFLINE_MAINTENANCE !== "1"
    ) {
      fail("RESET_POLLUTION_OFFLINE_MAINTENANCE_REQUIRED");
    }
    const runtimeIdentity = validateReleaseRuntimeEnvironment(
      process.env,
      compiledBuildSha || null,
    );
    assertKnowledgeBaseIncidentRepairCliRuntime({
      env: process.env,
      compiledBuildSha,
      compiledReleaseChannel,
      runtimeIdentity,
      readiness: resetPollutionMode ? null : await readiness(),
      skipLoopbackReadiness: resetPollutionMode,
    });
    connection = await acquireMaintenanceLock();
    const executed = await execute(command);
    const lockReleased = await releaseMaintenanceLock(connection);
    connection = null;
    if (executed.mode === "reset-pollution-preview") {
      if (!lockReleased) fail("LOCK_RELEASE_UNCONFIRMED");
      writeOutput(
        serializeResetPollutionCleanupCliResult({
          success: true,
          mode: executed.mode,
          ...executed.value,
        }),
      );
      return;
    }
    if (executed.mode === "reset-pollution-apply") {
      if (!lockReleased) fail("LOCK_RELEASE_UNCONFIRMED");
      writeOutput(
        serializeResetPollutionCleanupCliResult({
          success: true,
          mode: executed.mode,
          ...executed.value,
        }),
      );
      return;
    }
    result =
      executed.mode === "preview"
        ? knowledgeBaseIncidentRepairCliPreviewResult({
            preview: executed.value,
            buildSourceSha: compiledBuildSha,
            imageDigest: process.env.FRONTMIND_IMAGE_DIGEST!,
            lockReleased,
          })
        : knowledgeBaseIncidentRepairCliApplyResult({
            result: executed.value,
            buildSourceSha: compiledBuildSha,
            imageDigest: process.env.FRONTMIND_IMAGE_DIGEST!,
            lockReleased,
          });
  } catch (error) {
    const lockReleased = await releaseMaintenanceLock(connection);
    connection = null;
    if (
      command?.mode === "reset-pollution-preview" ||
      command?.mode === "reset-pollution-apply"
    ) {
      const raw = lockReleased && error instanceof Error ? error.message : "";
      writeOutput(
        serializeResetPollutionCleanupCliResult({
          success: false,
          mode: command.mode,
          code: raw,
        }),
      );
      process.exitCode = 1;
      return;
    }
    result = knowledgeBaseIncidentRepairCliFailureResult({
      error: lockReleased
        ? error
        : new Error("KB_INCIDENT_REPAIR_CLI_LOCK_RELEASE_UNCONFIRMED"),
      command,
      buildSourceSha: compiledBuildSha,
      imageDigest: process.env.FRONTMIND_IMAGE_DIGEST,
    });
  }
  writeOutput(serializeKnowledgeBaseIncidentRepairCliResult(result));
  if (!result.success) process.exitCode = 1;
}

await main();
