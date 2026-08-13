type ExpiredTurnRecoveryResult = {
  failed: number;
  claimedTurnIds?: readonly string[];
  [key: string]: unknown;
};

type OpenBuildRecoveryResult = {
  failed: number;
  hasMore: boolean;
  nextCursor: string | null;
  [key: string]: unknown;
};

type ArtifactCleanupResult = {
  failed: number;
  [key: string]: unknown;
};

type TerminalAnchorRecoveryResult = {
  failed: number;
  claimedTurnIds?: readonly string[];
  [key: string]: unknown;
};

type PreproviderReleaseResult = {
  failed: number;
  released?: number;
  [key: string]: unknown;
};

type ActiveLegacyMigrationResult = {
  failed: number;
  hasMore: boolean;
  nextCursor: string | null;
  rebindHasMore?: boolean;
  rebindNextCursor?: string | null;
  [key: string]: unknown;
};

/**
 * One production recovery sweep covers both durable reservations and legacy
 * open builds which no longer have an active turn. The cursor is retained
 * across bounded passes so a page of long-running rows cannot starve later
 * builds forever.
 */
export function createKnowledgeBaseRecoverySweep(input: {
  recoverExpiredTurns: () => Promise<ExpiredTurnRecoveryResult>;
  releaseGeneratedAttachmentInvalidTurns?: () => Promise<PreproviderReleaseResult>;
  recoverTerminalAnchorHandoffs?: () => Promise<TerminalAnchorRecoveryResult>;
  recoverOpenBuilds: (options: {
    limit: number;
    concurrency: number;
    afterBuildId?: string;
  }) => Promise<OpenBuildRecoveryResult>;
  cleanupArtifactCandidates?: () => Promise<ArtifactCleanupResult>;
  migrateActiveLegacyBuilds?: (options: {
    limit: number;
    concurrency: number;
    afterBuildId?: string;
    afterRebindBuildId?: string;
  }) => Promise<ActiveLegacyMigrationResult>;
  openBuildLimit?: number;
  openBuildConcurrency?: number;
}) {
  const limit = Math.min(
    500,
    Math.max(1, Math.trunc(input.openBuildLimit ?? 100)),
  );
  const concurrency = Math.min(
    8,
    Math.max(1, Math.trunc(input.openBuildConcurrency ?? 3)),
  );
  let afterBuildId: string | undefined;
  let afterLegacyBuildId: string | undefined;
  let afterRebindBuildId: string | undefined;

  return async () => {
    const turns = await input.recoverExpiredTurns();
    const releasedPreproviderTurns =
      input.releaseGeneratedAttachmentInvalidTurns
        ? await input.releaseGeneratedAttachmentInvalidTurns()
        : null;
    const terminalAnchors = input.recoverTerminalAnchorHandoffs
      ? await input.recoverTerminalAnchorHandoffs()
      : null;
    const builds = await input.recoverOpenBuilds({
      limit,
      concurrency,
      ...(afterBuildId ? { afterBuildId } : {}),
    });
    afterBuildId =
      builds.hasMore && builds.nextCursor ? builds.nextCursor : undefined;
    const migrations = input.migrateActiveLegacyBuilds
      ? await input.migrateActiveLegacyBuilds({
          limit,
          concurrency,
          ...(afterLegacyBuildId ? { afterBuildId: afterLegacyBuildId } : {}),
          ...(afterRebindBuildId ? { afterRebindBuildId } : {}),
        })
      : null;
    afterLegacyBuildId =
      migrations?.hasMore && migrations.nextCursor
        ? migrations.nextCursor
        : undefined;
    afterRebindBuildId =
      migrations?.rebindHasMore && migrations.rebindNextCursor
        ? migrations.rebindNextCursor
        : undefined;
    const artifacts = input.cleanupArtifactCandidates
      ? await input.cleanupArtifactCandidates()
      : null;
    return {
      failed:
        turns.failed +
        (releasedPreproviderTurns?.failed ?? 0) +
        (terminalAnchors?.failed ?? 0) +
        builds.failed +
        (migrations?.failed ?? 0) +
        (artifacts?.failed ?? 0),
      turns,
      releasedPreproviderTurns,
      terminalAnchors,
      builds,
      migrations,
      artifacts,
    };
  };
}
