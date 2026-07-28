import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertWorkspaceAccess: vi.fn(),
  writeWorkspaceAuditEvent: vi.fn(),
  getDb: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("./dashboard-service", () => ({
  assertWorkspaceAccess: mocks.assertWorkspaceAccess,
}));

vi.mock("./admin-control-plane-service", () => ({
  writeWorkspaceAuditEvent: mocks.writeWorkspaceAuditEvent,
}));

vi.mock("./db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: mocks.mkdir,
    readFile: mocks.readFile,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
  },
  mkdir: mocks.mkdir,
  readFile: mocks.readFile,
  unlink: mocks.unlink,
  writeFile: mocks.writeFile,
}));

import {
  createIcpMaterialDownloadUrl,
  readIcpMaterial,
  storeIcpMaterial,
  withdrawIcpMaterial,
} from "./icp-material-service";

type StoredMaterial = Record<string, any>;

function fakeMaterialDb(records: StoredMaterial[]) {
  const select = (selection?: Record<string, unknown>) => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
      where: () => ({
        limit: async (limit: number) => {
          const isRetentionScan =
            selection &&
            Object.keys(selection).length === 2 &&
            "storageKey" in selection;
          const source = isRetentionScan
            ? records.filter(
                (record) =>
                  ["active", "replaced"].includes(record.status) &&
                  record.retentionUntil.getTime() < Date.now(),
              )
            : records;
          return source.slice(0, limit);
        },
      }),
    }),
  });
  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        if (records[0]) Object.assign(records[0], values);
      },
    }),
  });
  const insert = () => ({
    values: async (value: StoredMaterial) => {
      records.push({ ...value });
    },
  });
  const tx = { select, update, insert };
  return {
    select,
    update,
    insert,
    transaction: async (callback: (executor: typeof tx) => unknown) =>
      callback(tx),
  };
}

const actor = {
  id: 41,
  username: "enterprise-user",
  role: "user",
  displayName: "企业用户",
  adminAccessLevel: null,
  isActive: true,
} as const;

describe("ICP protected material service", () => {
  const records: StoredMaterial[] = [];
  const storedFiles = new Map<string, Buffer>();

  beforeEach(() => {
    records.length = 0;
    storedFiles.clear();
    vi.clearAllMocks();
    process.env.FRONTMIND_ICP_MATERIAL_KEY =
      `base64:${Buffer.alloc(32, 7).toString("base64")}`;
    mocks.assertWorkspaceAccess.mockResolvedValue(undefined);
    mocks.writeWorkspaceAuditEvent.mockResolvedValue(undefined);
    mocks.getDb.mockResolvedValue(fakeMaterialDb(records));
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockImplementation(
      async (path: string, bytes: Buffer) => {
        storedFiles.set(String(path), Buffer.from(bytes));
      },
    );
    mocks.readFile.mockImplementation(async (path: string) => {
      const value = storedFiles.get(String(path));
      if (!value) throw new Error("missing protected file");
      return Buffer.from(value);
    });
    mocks.unlink.mockImplementation(async (path: string) => {
      storedFiles.delete(String(path));
    });
  });

  it("encrypts at rest, uses a short signed URL, and audits upload/download", async () => {
    const plaintext = Buffer.from(
      "business-license-number-must-not-be-visible",
      "utf8",
    );
    const created = await storeIcpMaterial({
      actor: actor as any,
      workspaceUserId: actor.id,
      filename: "营业执照.pdf",
      mimeType: "application/pdf",
      category: "business_license",
      bytes: plaintext,
    });

    expect(mocks.assertWorkspaceAccess).toHaveBeenCalledWith(actor, actor.id);
    expect(created.filename).toBe("ICP 敏感材料");
    expect(records).toHaveLength(1);
    const encrypted = [...storedFiles.values()][0]!;
    expect(encrypted.equals(plaintext)).toBe(false);
    expect(encrypted.toString("utf8")).not.toContain("business-license");
    expect(mocks.writeWorkspaceAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "icp_material.uploaded",
        workspaceUserId: actor.id,
      }),
      expect.anything(),
    );

    const url = new URL(
      createIcpMaterialDownloadUrl(created.id),
      "https://frontmind.test",
    );
    const downloaded = await readIcpMaterial({
      actor: actor as any,
      materialId: created.id,
      expires: url.searchParams.get("expires")!,
      signature: url.searchParams.get("signature")!,
    });

    expect(downloaded.bytes.equals(plaintext)).toBe(true);
    expect(mocks.writeWorkspaceAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "icp_material.downloaded",
        workspaceUserId: actor.id,
      }),
    );
  });

  it("rejects cross-workspace access before decrypting the material", async () => {
    const created = await storeIcpMaterial({
      actor: actor as any,
      workspaceUserId: actor.id,
      filename: "负责人证件.png",
      mimeType: "image/png",
      category: "subject_responsible_person_id",
      bytes: Buffer.from("sensitive-id-image"),
    });
    const url = new URL(
      createIcpMaterialDownloadUrl(created.id),
      "https://frontmind.test",
    );
    mocks.assertWorkspaceAccess.mockRejectedValueOnce(
      new Error("workspace access denied"),
    );
    mocks.readFile.mockClear();

    await expect(
      readIcpMaterial({
        actor: { ...actor, id: 99 } as any,
        materialId: created.id,
        expires: url.searchParams.get("expires")!,
        signature: url.searchParams.get("signature")!,
      }),
    ).rejects.toThrow("workspace access denied");
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("rejects forged links and permanently removes withdrawn ciphertext", async () => {
    const created = await storeIcpMaterial({
      actor: actor as any,
      workspaceUserId: actor.id,
      filename: "网站负责人证件.png",
      mimeType: "image/png",
      category: "website_responsible_person_id",
      bytes: Buffer.from("website-owner-id"),
    });
    const url = new URL(
      createIcpMaterialDownloadUrl(created.id),
      "https://frontmind.test",
    );

    await expect(
      readIcpMaterial({
        actor: actor as any,
        materialId: created.id,
        expires: url.searchParams.get("expires")!,
        signature: "forged-signature",
      }),
    ).rejects.toMatchObject({ code: "ICP_DOWNLOAD_URL_EXPIRED" });

    await withdrawIcpMaterial({
      actor: actor as any,
      materialId: created.id,
    });
    expect(records[0]?.status).toBe("withdrawn");
    expect(storedFiles.size).toBe(0);
    expect(mocks.writeWorkspaceAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "icp_material.withdrawn" }),
      expect.anything(),
    );
  });
});
