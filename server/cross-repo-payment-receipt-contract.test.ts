import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { paymentReceiptResponseSchema } from "../shared/payment-receipt";

const agentFixturePath = path.resolve(
  process.cwd(),
  "shared/contracts/payment-receipt-v1.fixture.json",
);
const websiteFixturePath = path.resolve(
  process.cwd(),
  "../frontmind-website/server/geo/contracts/payment-receipt-v1.fixture.json",
);

async function fixture(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

describe("Agent ↔ Website payment receipt v1 shared contract", () => {
  it("parses the Agent-owned fixture and matches the Website-owned copy", async () => {
    const agent = paymentReceiptResponseSchema.parse(
      await fixture(agentFixturePath),
    );
    const website = paymentReceiptResponseSchema.parse(
      await fixture(websiteFixturePath),
    );
    expect(website).toEqual(agent);
  });
});
