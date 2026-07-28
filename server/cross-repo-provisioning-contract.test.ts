import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { websitePurchaseRequestV2Schema } from "../shared/provisioning-v2";
import { knowledgeArchiveDescriptorHash } from "./knowledge-base-artifact";
import { websiteKnowledgeImportSchema } from "./knowledge-import-service";

const localFixturePath = path.resolve(
  process.cwd(),
  "shared/contracts/provisioning-v2.fixture.json",
);
const websiteFixturePath = path.resolve(
  process.cwd(),
  "../frontmind-website/server/geo/contracts/provisioning-v2.fixture.json",
);

async function fixture(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Agent ↔ Website provisioning v2 shared contract", () => {
  it("parses the shared purchase, categories, and knowledge artifact contract", async () => {
    const value = await fixture(localFixturePath);
    const request = value.purchaseRequest as Record<string, any>;
    for (const category of value.questionCategories as string[]) {
      expect(
        websitePurchaseRequestV2Schema.parse({
          ...request,
          service: {
            ...request.service,
            purchasedQuestion: {
              ...request.service.purchasedQuestion,
              category,
            },
          },
        }).service.purchasedQuestion.category,
      ).toBe(category);
    }
    const knowledgeImport = websiteKnowledgeImportSchema.parse(
      value.knowledgeImport,
    );
    expect(
      knowledgeArchiveDescriptorHash(value.artifactDescriptor as any),
    ).toBe(knowledgeImport.descriptorHash);
  });

  it("matches the Website-owned copy when both repositories are checked out", async () => {
    const agent = await fixture(localFixturePath);
    const website = await fixture(websiteFixturePath);
    expect(website).toEqual(agent);
  });
});
