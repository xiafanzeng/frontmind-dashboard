import type { Connection, RowDataPacket } from "mysql2/promise";
import mysql from "mysql2/promise";

import { closeDbForOneShotMaintenance } from "./db";
import {
  GENERAL_CHAT_INCIDENT_REPAIR_ID,
  GENERAL_CHAT_INCIDENT_REPAIR_LOCK,
  automaticGeneralChatIncidentRepairEnabled,
  generalChatIncidentFailureCode,
  parseGeneralChatIncidentRepairCommand,
  type GeneralChatIncidentRepairSummary,
} from "./general-chat-incident-repair-20260828-core";
import {
  executeGeneralChatIncidentRepair,
  inspectGeneralChatIncidentRepair,
  isGeneralChatIncidentRepairLocallyComplete,
} from "./general-chat-incident-repair-20260828";
import { syncGeneralChatTaskForRepair } from "./frontmind-v2-chat-router";
import { validateReleaseRuntimeEnvironment } from "./_core/release-channel-adapter";

declare const __FRONTMIND_BUILD_SHA__: string | undefined;
declare const __FRONTMIND_RELEASE_CHANNEL__: string | undefined;

const LOOPBACK_READINESS_URL = "http://127.0.0.1:3001/readyz";
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_SHA = /^[a-f0-9]{40}$/u;

function fail(code: string): never {
  throw new Error(`GENERAL_CHAT_INCIDENT_${code}`);
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
    return (await response.json()) as Record<string, unknown>;
  } catch {
    fail("READINESS_INVALID");
  }
}

function assertRuntime(input: {
  compiledBuildSha: string;
  compiledReleaseChannel: string;
  ready: Record<string, unknown>;
}) {
  if (
    process.env.NODE_ENV !== "production" ||
    input.compiledReleaseChannel !== "production" ||
    !SOURCE_SHA.test(input.compiledBuildSha)
  ) {
    fail("PRODUCTION_SIGNED_IMAGE_REQUIRED");
  }
  validateReleaseRuntimeEnvironment(process.env, input.compiledBuildSha);
  const imageDigest = process.env.FRONTMIND_IMAGE_DIGEST?.trim().toLowerCase();
  if (!imageDigest || !SHA256_DIGEST.test(imageDigest)) {
    fail("IMAGE_DIGEST_REQUIRED");
  }
  const build =
    input.ready.build &&
    typeof input.ready.build === "object" &&
    !Array.isArray(input.ready.build)
      ? (input.ready.build as Record<string, unknown>)
      : null;
  const migration =
    input.ready.migration &&
    typeof input.ready.migration === "object" &&
    !Array.isArray(input.ready.migration)
      ? (input.ready.migration as Record<string, unknown>)
      : null;
  const schema =
    migration?.schema &&
    typeof migration.schema === "object" &&
    !Array.isArray(migration.schema)
      ? (migration.schema as Record<string, unknown>)
      : null;
  if (
    input.ready.status !== "ok" ||
    build?.sha !== input.compiledBuildSha ||
    build?.imageDigest !== imageDigest ||
    migration?.status !== "exact" ||
    schema?.status !== "exact"
  ) {
    fail("RUNNING_RELEASE_IDENTITY_MISMATCH");
  }
}

async function acquireLock(): Promise<Connection> {
  if (!process.env.DATABASE_URL) fail("DATABASE_URL_REQUIRED");
  const connection = await mysql
    .createConnection({ uri: process.env.DATABASE_URL, timezone: "Z" })
    .catch(() => fail("DATABASE_LOCK_UNAVAILABLE"));
  const [rows] = await connection
    .execute<
      RowDataPacket[]
    >("SELECT GET_LOCK(?, 0) AS acquired", [GENERAL_CHAT_INCIDENT_REPAIR_LOCK])
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

async function releaseLock(connection: Connection | null) {
  if (!connection) return true;
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT RELEASE_LOCK(?) AS released",
      [GENERAL_CHAT_INCIDENT_REPAIR_LOCK],
    );
    await connection.end();
    return Number(rows[0]?.released) === 1;
  } catch {
    await connection.end().catch(() => undefined);
    return false;
  }
}

export async function runGeneralChatIncidentRepairCli(
  args: readonly string[],
): Promise<GeneralChatIncidentRepairSummary> {
  const compiledBuildSha =
    typeof __FRONTMIND_BUILD_SHA__ === "string"
      ? __FRONTMIND_BUILD_SHA__.trim().toLowerCase()
      : "";
  const compiledReleaseChannel =
    typeof __FRONTMIND_RELEASE_CHANNEL__ === "string"
      ? __FRONTMIND_RELEASE_CHANNEL__.trim().toLowerCase()
      : "";
  let mode: "preview" | "apply" = "preview";
  let connection: Connection | null = null;
  try {
    const command = parseGeneralChatIncidentRepairCommand(args);
    mode = command.mode;
    assertRuntime({
      compiledBuildSha,
      compiledReleaseChannel,
      ready: await readiness(),
    });
    connection = await acquireLock();
    const result = await executeGeneralChatIncidentRepair(command, {
      syncTask: async (input) => {
        await syncGeneralChatTaskForRepair(input);
      },
    });
    const lockReleased = await releaseLock(connection);
    connection = null;
    if (!lockReleased) fail("LOCK_RELEASE_UNCONFIRMED");
    await closeDbForOneShotMaintenance();
    return {
      schemaVersion: 1,
      incident: GENERAL_CHAT_INCIDENT_REPAIR_ID,
      mode,
      success: true,
      applicable: !result.before.complete,
      applied: result.applied,
      stateHash: result.before.stateHash,
      finalStateHash: result.after.stateHash,
      counts: result.after.counts,
      build: {
        sha: compiledBuildSha,
        imageDigest:
          process.env.FRONTMIND_IMAGE_DIGEST?.trim().toLowerCase() ?? null,
      },
      errorCode: null,
    };
  } catch (error) {
    const released = await releaseLock(connection);
    connection = null;
    await closeDbForOneShotMaintenance().catch(() => undefined);
    return {
      schemaVersion: 1,
      incident: GENERAL_CHAT_INCIDENT_REPAIR_ID,
      mode,
      success: false,
      applicable: false,
      applied: false,
      stateHash: null,
      finalStateHash: null,
      counts: null,
      build: {
        sha: compiledBuildSha || null,
        imageDigest:
          process.env.FRONTMIND_IMAGE_DIGEST?.trim().toLowerCase() ?? null,
      },
      errorCode: released
        ? generalChatIncidentFailureCode(error)
        : "LOCK_RELEASE_UNCONFIRMED",
    };
  }
}

const AUTOMATIC_MAX_ATTEMPTS = 6;
const AUTOMATIC_RETRY_DELAY_MS = 30_000;

function automaticRuntimeEnabled() {
  const compiledReleaseChannel =
    typeof __FRONTMIND_RELEASE_CHANNEL__ === "string"
      ? __FRONTMIND_RELEASE_CHANNEL__.trim().toLowerCase()
      : "";
  return automaticGeneralChatIncidentRepairEnabled({
    nodeEnv: process.env.NODE_ENV,
    compiledReleaseChannel,
    publicUrl: process.env.FRONTMIND_PUBLIC_URL,
  });
}

async function runAutomaticAttempt() {
  const compiledBuildSha =
    typeof __FRONTMIND_BUILD_SHA__ === "string"
      ? __FRONTMIND_BUILD_SHA__.trim().toLowerCase()
      : "";
  const compiledReleaseChannel =
    typeof __FRONTMIND_RELEASE_CHANNEL__ === "string"
      ? __FRONTMIND_RELEASE_CHANNEL__.trim().toLowerCase()
      : "";
  assertRuntime({
    compiledBuildSha,
    compiledReleaseChannel,
    ready: await readiness(),
  });
  let connection: Connection | null = await acquireLock();
  try {
    if (await isGeneralChatIncidentRepairLocallyComplete()) return;
    const preview = await inspectGeneralChatIncidentRepair();
    if (!preview.complete) {
      await executeGeneralChatIncidentRepair(
        { mode: "apply", expectedStateHash: preview.stateHash },
        {
          syncTask: async (input) => {
            await syncGeneralChatTaskForRepair(input);
          },
        },
      );
    }
  } finally {
    const released = await releaseLock(connection);
    connection = null;
    if (!released) fail("LOCK_RELEASE_UNCONFIRMED");
  }
}

/**
 * The incident was explicitly authorized for production recovery. Schedule it
 * only after the web listener exists, and only in the exact canonical
 * production runtime. Dev, workers and non-canonical deployments never apply.
 */
export function scheduleAutomaticGeneralChatIncidentRepair20260828() {
  if (!automaticRuntimeEnabled()) return false;
  let attempts = 0;
  const run = async () => {
    attempts += 1;
    try {
      await runAutomaticAttempt();
      console.info("[GeneralChatIncidentRepair] complete", {
        incident: GENERAL_CHAT_INCIDENT_REPAIR_ID,
        attempts,
      });
    } catch (error) {
      const errorCode = generalChatIncidentFailureCode(error);
      if (attempts >= AUTOMATIC_MAX_ATTEMPTS) {
        console.error("[GeneralChatIncidentRepair] failed", {
          incident: GENERAL_CHAT_INCIDENT_REPAIR_ID,
          attempts,
          errorCode,
        });
        return;
      }
      console.warn("[GeneralChatIncidentRepair] retry_scheduled", {
        incident: GENERAL_CHAT_INCIDENT_REPAIR_ID,
        attempts,
        errorCode,
      });
      const retry = setTimeout(() => void run(), AUTOMATIC_RETRY_DELAY_MS);
      retry.unref();
    }
  };
  const initial = setTimeout(() => void run(), 5_000);
  initial.unref();
  return true;
}
