import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

import {
  canonicalKnowledgeBaseSkillArchiveHash,
  legacyKnowledgeBaseSkillInstructionHash,
} from "../shared/knowledge-base-skill-archive-hash.js";
import {
  persistKnowledgeBaseSkillArchive,
  readKnowledgeBaseLocalSource,
} from "./knowledge-base-local-source-store";

const configuredKnowledgeBaseSkillPath =
  process.env.FRONTMIND_KB_SKILL_PATH?.trim();
if (
  configuredKnowledgeBaseSkillPath &&
  !path.isAbsolute(configuredKnowledgeBaseSkillPath)
) {
  throw new Error("FRONTMIND_KB_SKILL_PATH must be an absolute path");
}

const skillArchiveCandidates = configuredKnowledgeBaseSkillPath
  ? [configuredKnowledgeBaseSkillPath]
  : [
      path.resolve(
        import.meta.dirname,
        "private-workflows",
        "socratic-kb-builder.skill",
      ),
      path.resolve(
        process.cwd(),
        "private-workflows",
        "socratic-kb-builder.skill",
      ),
      path.resolve(
        import.meta.dirname,
        "..",
        "private-workflows",
        "socratic-kb-builder.skill",
      ),
      path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "private-workflows",
        "socratic-kb-builder.skill",
      ),
    ];

const legacySkillArchiveCandidates = configuredKnowledgeBaseSkillPath
  ? [
      path.join(
        path.dirname(configuredKnowledgeBaseSkillPath),
        "socratic-kb-builder-v1.skill",
      ),
    ]
  : skillArchiveCandidates.map((candidate) =>
      path.join(path.dirname(candidate), "socratic-kb-builder-v1.skill"),
    );
const v3SkillArchiveCandidates = skillArchiveCandidates.map((candidate) =>
  path.join(path.dirname(candidate), "socratic-kb-builder-v3.skill"),
);
const v4SkillArchiveCandidates = skillArchiveCandidates.map((candidate) =>
  path.join(path.dirname(candidate), "socratic-kb-builder-v4.skill"),
);

export interface KnowledgeBaseSkillSelection {
  version: string;
  contentHash?: string | null;
}

export interface KnowledgeBaseSkillPhysicalPin {
  physicalSha256?: string | null;
  archiveBytes?: number | null;
  storageKey?: string | null;
}

/**
 * Final delivery for a v4 build must use the exact immutable archive selected
 * at build creation. Falling back to `latest` would silently turn an 8–115
 * historical build into a 30–115 build during confirm, retry or recovery.
 */
export function knowledgeBasePinnedV4SkillSelection(input: {
  skillVersion: string;
  skillContentHash?: string | null;
}): KnowledgeBaseSkillSelection & { version: "4"; contentHash: string } {
  const contentHash = String(input.skillContentHash || "")
    .trim()
    .toLowerCase();
  if (input.skillVersion !== "4" || !/^[a-f0-9]{64}$/u.test(contentHash)) {
    throw new Error(
      "Knowledge-base v4 build is missing its immutable Skill content hash",
    );
  }
  return { version: "4", contentHash };
}

interface LoadedKnowledgeBaseSkill {
  instructions: string;
  contentHash: string;
  archivePath: string;
  /** Exact on-disk bytes selected for this immutable build pin. */
  physicalSha256: string;
  archiveBytes: number;
}

const skillArchiveCache = new Map<string, LoadedKnowledgeBaseSkill>();

async function physicalSkillArchiveDescriptor(archivePath: string) {
  const bytes = await fs.readFile(archivePath);
  return {
    bytes,
    physicalSha256: createHash("sha256").update(bytes).digest("hex"),
    archiveBytes: bytes.length,
  };
}

export const KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME =
  "socratic-kb-builder.skill.zip";

async function loadKnowledgeBaseSkillArchiveInternal(
  selection: KnowledgeBaseSkillSelection,
  allowHistoricalAlias: boolean,
) {
  const version =
    selection.version === "1"
      ? "1"
      : selection.version === "2"
        ? "2"
        : selection.version === "3"
          ? "3"
          : "4";
  const cacheKey = `${allowHistoricalAlias ? "historical" : "strict"}:${version}:${selection.contentHash || "latest"}`;
  const cached = skillArchiveCache.get(cacheKey);
  if (cached) {
    if (selection.contentHash && selection.contentHash !== cached.contentHash) {
      throw new Error(
        `Knowledge-base Skill v${version} content hash does not match the active build`,
      );
    }
    // Never trust the filename or process cache alone. A historical alias can
    // be replaced on disk during a rollout; re-read and validate the exact
    // bytes before returning the pinned archive to any new operation.
    const { bytes: _bytes, ...physical } = await physicalSkillArchiveDescriptor(
      cached.archivePath,
    );
    if (
      physical.physicalSha256 !== cached.physicalSha256 ||
      physical.archiveBytes !== cached.archiveBytes
    ) {
      skillArchiveCache.delete(cacheKey);
      throw new Error(
        `Knowledge-base Skill v${version} physical archive does not match the active build`,
      );
    }
    return { ...cached, ...physical };
  }

  let lastError: unknown;
  let contentHashMismatchError: Error | null = null;
  const candidates =
    version === "1"
      ? legacySkillArchiveCandidates
      : version === "2"
        ? skillArchiveCandidates
        : version === "3"
          ? [
              ...(selection.contentHash
                ? v3SkillArchiveCandidates.map((candidate) =>
                    path.join(
                      path.dirname(candidate),
                      `socratic-kb-builder-v3-${selection.contentHash}.skill`,
                    ),
                  )
                : []),
              ...v3SkillArchiveCandidates,
            ]
          : [
              ...(selection.contentHash
                ? v4SkillArchiveCandidates.map((candidate) =>
                    path.join(
                      path.dirname(candidate),
                      `socratic-kb-builder-v4-${selection.contentHash}.skill`,
                    ),
                  )
                : []),
              ...v4SkillArchiveCandidates,
            ];
  for (const candidate of candidates) {
    try {
      const archive = await fs.readFile(candidate);
      const zip = await JSZip.loadAsync(archive);
      const entries =
        version !== "1"
          ? ([["SKILL.md", "Skill"]] as const)
          : ([
              ["SKILL.md", "Skill"],
              ["references/knowledge-tree.md", "Knowledge Tree"],
              ["references/questioning-strategy.md", "Questioning Strategy"],
              ["references/output-format.md", "Output Format"],
            ] as const);

      const sections: string[] = [];
      for (const [entryName, title] of entries) {
        const entry = zip.file(entryName);
        if (!entry) {
          throw new Error(`Missing ${entryName} in socratic-kb-builder.skill`);
        }
        const content = await entry.async("string");
        sections.push(`# ${title}\n\n${content.trim()}`);
      }

      const instructions = sections.join("\n\n---\n\n");
      const canonicalArchiveHash =
        version === "3" || version === "4"
          ? await canonicalKnowledgeBaseSkillArchiveHash(archive)
          : null;
      const legacyInstructionHash =
        version === "3" || version === "4"
          ? await legacyKnowledgeBaseSkillInstructionHash(archive)
          : null;
      const historicalInstructionHash = createHash("sha256")
        .update(instructions)
        .digest("hex");
      const acceptedHashes = new Set(
        [
          canonicalArchiveHash,
          legacyInstructionHash,
          version === "3" || version === "4" ? null : historicalInstructionHash,
        ].filter(Boolean),
      );
      const exactHistoricalAlias = Boolean(
        allowHistoricalAlias &&
          selection.contentHash &&
          path.basename(candidate) ===
            `socratic-kb-builder-v${version}-${selection.contentHash}.skill`,
      );
      if (
        selection.contentHash &&
        !acceptedHashes.has(selection.contentHash) &&
        !exactHistoricalAlias
      ) {
        contentHashMismatchError = new Error(
          `Knowledge-base Skill v${version} content hash does not match the active build`,
        );
        continue;
      }
      const loaded = {
        instructions,
        // New v3/v4 builds pin the full logical archive. Old deployments used
        // more than one hash algorithm; an exact immutable historical alias is
        // therefore an explicit compatibility mapping. Keep returning the
        // selected pin so recovery never rewrites durable build identity.
        contentHash:
          selection.contentHash ||
          canonicalArchiveHash ||
          historicalInstructionHash,
        archivePath: candidate,
        physicalSha256: createHash("sha256").update(archive).digest("hex"),
        archiveBytes: archive.length,
      };
      skillArchiveCache.set(cacheKey, loaded);
      return loaded;
    } catch (error) {
      lastError = error;
    }
  }

  if (contentHashMismatchError) {
    throw contentHashMismatchError;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not load socratic-kb-builder Skill v${version}`);
}

export async function loadKnowledgeBaseSkillArchive(
  selection: KnowledgeBaseSkillSelection = { version: "4" },
) {
  return loadKnowledgeBaseSkillArchiveInternal(selection, false);
}

async function readKnowledgeBaseReleaseSkillArchiveAttachment(
  selection: KnowledgeBaseSkillSelection,
  allowHistoricalAlias: boolean,
) {
  const loaded = await loadKnowledgeBaseSkillArchiveInternal(
    selection,
    allowHistoricalAlias,
  );
  const physical = await physicalSkillArchiveDescriptor(loaded.archivePath);
  if (
    physical.physicalSha256 !== loaded.physicalSha256 ||
    physical.archiveBytes !== loaded.archiveBytes
  ) {
    throw new Error(
      "Knowledge-base Skill physical archive changed after selection",
    );
  }
  const retained = await persistKnowledgeBaseSkillArchive(physical.bytes);
  return {
    filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
    bytes: physical.bytes,
    contentHash: loaded.contentHash,
    physicalSha256: retained.contentSha256,
    archiveBytes: retained.sizeBytes,
    storageKey: retained.storageKey,
  };
}

export async function readKnowledgeBaseSkillArchiveAttachment(
  selection: KnowledgeBaseSkillSelection = { version: "4" },
) {
  return readKnowledgeBaseReleaseSkillArchiveAttachment(selection, false);
}

/**
 * Read a build's physical Skill pin. A complete durable pin is resolved only
 * from Dashboard asset storage. Historical builds may have no physical proof,
 * or may carry the old release-local absolute locator; those are backfilled
 * from the release archive exactly once, and any existing SHA/size proof must
 * match before the durable copy is returned.
 */
export async function readKnowledgeBasePinnedSkillArchiveAttachment(
  input: KnowledgeBaseSkillSelection & KnowledgeBaseSkillPhysicalPin,
) {
  const logicalContentHash = String(input.contentHash || "")
    .trim()
    .toLowerCase();
  if (!logicalContentHash) {
    throw new Error("Knowledge-base Skill logical build pin is missing");
  }
  const physicalSha256 = String(input.physicalSha256 || "")
    .trim()
    .toLowerCase();
  const archiveBytes = input.archiveBytes ?? null;
  const storageKey = String(input.storageKey || "").trim();
  const hasSha = physicalSha256.length > 0;
  const hasBytes = archiveBytes !== null;
  const controlledStorageKey = storageKey && !path.isAbsolute(storageKey);

  if (controlledStorageKey) {
    if (
      !/^[a-f0-9]{64}$/u.test(physicalSha256) ||
      !Number.isSafeInteger(archiveBytes) ||
      Number(archiveBytes) < 1
    ) {
      throw new Error(
        "Knowledge-base Skill durable physical pin is incomplete",
      );
    }
    const bytes = await readKnowledgeBaseLocalSource({
      storageKey,
      contentSha256: physicalSha256,
      sizeBytes: Number(archiveBytes),
    });
    return {
      filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
      bytes,
      contentHash: logicalContentHash,
      physicalSha256,
      archiveBytes: Number(archiveBytes),
      storageKey,
    };
  }

  if (hasSha !== hasBytes) {
    throw new Error("Knowledge-base Skill physical pin is incomplete");
  }
  if (
    hasSha &&
    (!/^[a-f0-9]{64}$/u.test(physicalSha256) ||
      !Number.isSafeInteger(archiveBytes) ||
      Number(archiveBytes) < 1)
  ) {
    throw new Error("Knowledge-base Skill physical pin is invalid");
  }

  const archive = await readKnowledgeBaseReleaseSkillArchiveAttachment(
    {
      version: input.version,
      contentHash: input.contentHash,
    },
    true,
  );
  if (
    (hasSha && archive.physicalSha256 !== physicalSha256) ||
    (hasBytes && archive.archiveBytes !== archiveBytes)
  ) {
    throw new Error(
      "Knowledge-base Skill release archive does not match the build physical pin",
    );
  }
  return archive;
}

export async function getKnowledgeBaseSkillDescriptor(
  selection: KnowledgeBaseSkillSelection = { version: "4" },
) {
  const version =
    selection.version === "1"
      ? "1"
      : selection.version === "2"
        ? "2"
        : selection.version === "3"
          ? "3"
          : "4";
  const archive = await readKnowledgeBaseSkillArchiveAttachment({
    version,
    contentHash: selection.contentHash,
  });
  return {
    name: "socratic-kb-builder",
    version,
    contentHash: archive.contentHash,
    physicalSha256: archive.physicalSha256,
    archiveBytes: archive.archiveBytes,
    storageKey: archive.storageKey,
  };
}
