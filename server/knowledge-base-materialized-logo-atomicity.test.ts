import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { materializedKnowledgeBaseStagedOfficialLogo } from "./knowledge-base-artifact-binding-service";
import {
  materializedOfficialLogoActivationPlan,
  materializedStagedOfficialLogoFromTurnMetadata,
} from "./knowledge-base-materialized-service";

const operationKey = "kb:revise:logo-operation";
const expectedLeafId = "1.1";
const expectedRevision = 7;
const sha256 = "a".repeat(64);

function stagedLogoMetadata() {
  const stagedOfficialLogo = materializedKnowledgeBaseStagedOfficialLogo({
    operationKey,
    expectedRevision,
    expectedLeafId,
    staged: {
      storageKey: "knowledge-builds/staging/new-logo.png",
      sha256,
      bytes: 1234,
    },
    filename: "new-logo.png",
    mimeType: "image/png",
    sourceSha256: sha256,
  });
  return {
    recovery: {
      manualLogoSubmission: true,
      officialLogoUpload: {
        verified: true,
        index: 0,
        fileId: "local-logo-asset",
        filename: "new-logo.png",
        mimeType: "image/png",
        sizeBytes: 1234,
        sourceSha256: sha256,
      },
      stagedOfficialLogo,
    },
  };
}

describe("materialized Logo replacement atomicity", () => {
  it("round-trips only the exact server-authored staging ledger", () => {
    const staged = materializedStagedOfficialLogoFromTurnMetadata({
      metadata: stagedLogoMetadata(),
      operationKey,
      expectedRevision,
      expectedLeafId,
    });
    expect(staged).toEqual(
      expect.objectContaining({
        storageKey: "knowledge-builds/staging/new-logo.png",
        sha256,
        bytes: 1234,
        filename: "new-logo.png",
        mimeType: "image/png",
      }),
    );
    expect(() =>
      materializedStagedOfficialLogoFromTurnMetadata({
        metadata: stagedLogoMetadata(),
        operationKey,
        expectedRevision: expectedRevision + 1,
        expectedLeafId,
      }),
    ).toThrowError(expect.objectContaining({ code: "PATCH_CONFLICT" }));
  });

  it("switches different Logo coordinates only with the PATCH and cleans the old file post-commit", () => {
    const staged = materializedStagedOfficialLogoFromTurnMetadata({
      metadata: stagedLogoMetadata(),
      operationKey,
      expectedRevision,
      expectedLeafId,
    })!;
    expect(
      materializedOfficialLogoActivationPlan({
        current: {
          storageKey: "knowledge-builds/authoritative/old-logo.png",
          sha256: "b".repeat(64),
          bytes: 999,
          mimeType: "image/png",
        },
        staged,
      }),
    ).toEqual({
      logoUpdate: {
        logoStorageKey: staged.storageKey,
        logoSha256: staged.sha256,
        logoBytes: staged.bytes,
        logoFilename: staged.filename,
        logoMimeType: staged.mimeType,
      },
      oldStorageKey: "knowledge-builds/authoritative/old-logo.png",
      removeStaged: false,
    });
  });

  it("keeps identical authoritative bytes and removes only the duplicate staging file", () => {
    const staged = materializedStagedOfficialLogoFromTurnMetadata({
      metadata: stagedLogoMetadata(),
      operationKey,
      expectedRevision,
      expectedLeafId,
    })!;
    expect(
      materializedOfficialLogoActivationPlan({
        current: {
          storageKey: "knowledge-builds/authoritative/same-logo.png",
          sha256: staged.sha256,
          bytes: staged.bytes,
          mimeType: staged.mimeType,
        },
        staged,
      }),
    ).toEqual({
      logoUpdate: null,
      oldStorageKey: null,
      removeStaged: true,
    });
  });

  it("guards the transaction boundary: staging never writes build Logo coordinates", () => {
    const bindingSource = readFileSync(
      path.join(
        process.cwd(),
        "server/knowledge-base-artifact-binding-service.ts",
      ),
      "utf8",
    );
    const deferredStart = bindingSource.indexOf(
      'if (input.activation === "materialized_patch")',
    );
    const nextBuildWrite = bindingSource.indexOf(
      ".update(knowledgeBaseBuilds)",
      deferredStart,
    );
    const deferredBranch = bindingSource.slice(deferredStart, nextBuildWrite);
    expect(deferredStart).toBeGreaterThan(0);
    expect(deferredBranch).toContain(".update(conversationTurns)");
    expect(deferredBranch).toContain("return verifiedUpload");

    const activationSource = readFileSync(
      path.join(process.cwd(), "server/knowledge-base-materialized-service.ts"),
      "utf8",
    );
    const transactionStart = activationSource.indexOf(
      "const activated = await db.transaction",
    );
    const postCommitCleanup = activationSource.indexOf(
      "Filesystem deletion is intentionally post-commit",
      transactionStart,
    );
    const transactionBody = activationSource.slice(
      transactionStart,
      postCommitCleanup,
    );
    expect(transactionBody).toContain("activeWorkingSetId: nextWorkingSetId");
    expect(transactionBody).toContain("...(logoActivation.logoUpdate ?? {})");
    expect(postCommitCleanup).toBeGreaterThan(transactionStart);
  });
});
