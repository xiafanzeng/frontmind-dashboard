import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createKnowledgeBaseTurnTask: vi.fn(),
  cancelKnowledgeBaseStartReservation: vi.fn(),
  discardManagedUploadIntent: vi.fn(),
  listManagedUploadsForKnowledgeBase: vi.fn(),
  recoverDiscoveredManagedUpload: vi.fn(),
  stageKnowledgeBaseTurnAttachment: vi.fn(),
  uploadFile: vi.fn(),
  onObservation: vi.fn(),
  onRecovered: vi.fn(),
  onCancelled: vi.fn(),
}));

vi.mock("@/lib/attachment-files", () => ({
  normalizedKnowledgeBaseUploadFilename: (name: string) => name,
  normalizedKnowledgeBaseUploadMimeType: (file: File) =>
    file.type || "application/octet-stream",
  sha256UploadFile: vi.fn().mockResolvedValue("a".repeat(64)),
}));

vi.mock("@/lib/frontmind-api", () => ({
  createKnowledgeBaseTurnTask: mocks.createKnowledgeBaseTurnTask,
  cancelKnowledgeBaseStartReservation:
    mocks.cancelKnowledgeBaseStartReservation,
  discardManagedUploadIntent: mocks.discardManagedUploadIntent,
  listManagedUploadsForKnowledgeBase: mocks.listManagedUploadsForKnowledgeBase,
  recoverDiscoveredManagedUpload: mocks.recoverDiscoveredManagedUpload,
  stageKnowledgeBaseTurnAttachment: mocks.stageKnowledgeBaseTurnAttachment,
  uploadFile: mocks.uploadFile,
}));

import KnowledgeBaseManagedUploadRecovery from "./KnowledgeBaseManagedUploadRecovery";

const conversationId = "conversation-cross-device";
const turnId = "turn-start-reservation";
const clientRequestId = "request-start-reservation";

function manifestItem(index: number) {
  return {
    filename: `source-${index}.pdf`,
    sizeBytes: 10_000 + index,
    mimeType: "application/pdf",
    lastModified: 1_755_000_000_000 + index,
    sha256: String(index).repeat(64),
    itemId: `item-${index}`,
    ordinal: index,
    total: 3,
  };
}

function uploadedDiscoveryItem(index: number) {
  const manifest = manifestItem(index);
  return {
    intentId: `intent-${index}`,
    intentTicket: `ticket-${index}`,
    ticketExpiresAt: Date.now() + 60_000,
    batchId: clientRequestId,
    ordinal: index,
    total: 3,
    filename: manifest.filename,
    mimeType: manifest.mimeType,
    sizeBytes: manifest.sizeBytes,
    state: "uploaded",
    phase: "uploaded",
    receipt: {
      fileId: `dashboard-file-${index}`,
      filename: manifest.filename,
      sizeBytes: manifest.sizeBytes,
      uploadedAt: Date.now(),
      providerReadyAt: Date.now(),
      replayed: false,
      recovered: false,
    },
    clientRequestId,
  };
}

function unresolvedDiscoveryItem(state: "receiving" | "awaiting_browser") {
  const manifest = manifestItem(1);
  return {
    intentId: "intent-1",
    intentTicket: "ticket-1",
    ticketExpiresAt: Date.now() + 60_000,
    batchId: clientRequestId,
    ordinal: 1,
    total: 1,
    filename: manifest.filename,
    mimeType: manifest.mimeType,
    sizeBytes: manifest.sizeBytes,
    state,
    phase: state,
    receipt: null,
    clientRequestId,
  };
}

function renderRecovery() {
  return render(
    <KnowledgeBaseManagedUploadRecovery
      conversationId={conversationId}
      turnId={turnId}
      onObservation={mocks.onObservation}
      onRecovered={mocks.onRecovered}
      onCancelled={mocks.onCancelled}
    />,
  );
}

describe("KnowledgeBaseManagedUploadRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stageKnowledgeBaseTurnAttachment.mockResolvedValue({ ok: true });
    mocks.createKnowledgeBaseTurnTask.mockResolvedValue({
      knowledgeObservation: {
        generation: 2,
        stateEpoch: 9,
        displaySequence: 12,
        interaction: { interactionState: "running", progress: null },
      },
    });
    mocks.cancelKnowledgeBaseStartReservation.mockResolvedValue({
      cancelled: true,
      resetRevision: 10,
      idempotent: false,
    });
    mocks.discardManagedUploadIntent.mockResolvedValue(undefined);
    mocks.onCancelled.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("uses uploaded server receipts with zero browser body, stages the frozen manifest from its saved count, and dispatches once", async () => {
    const attachmentManifest = [
      manifestItem(1),
      manifestItem(2),
      manifestItem(3),
    ];
    const uploads = [
      uploadedDiscoveryItem(3),
      uploadedDiscoveryItem(1),
      uploadedDiscoveryItem(2),
    ];
    mocks.listManagedUploadsForKnowledgeBase.mockResolvedValue({
      uploads,
      reservation: {
        clientRequestId,
        sourceResetRevision: 7,
        attachmentManifest,
        stagedAttachmentCount: 1,
      },
    });

    renderRecovery();

    await waitFor(() =>
      expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledOnce(),
    );

    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.recoverDiscoveredManagedUpload).not.toHaveBeenCalled();
    expect(mocks.stageKnowledgeBaseTurnAttachment).toHaveBeenCalledTimes(2);
    expect(
      mocks.stageKnowledgeBaseTurnAttachment.mock.calls.map(
        ([input]) => input.index,
      ),
    ).toEqual([1, 2]);
    expect(mocks.stageKnowledgeBaseTurnAttachment.mock.calls[0]![0]).toEqual({
      conversationId,
      turnId,
      clientRequestId,
      attachmentManifest,
      index: 1,
      attachment: {
        file_id: "dashboard-file-2",
        filename: "source-2.pdf",
      },
    });
    expect(mocks.stageKnowledgeBaseTurnAttachment.mock.calls[1]![0]).toEqual({
      conversationId,
      turnId,
      clientRequestId,
      attachmentManifest,
      index: 2,
      attachment: {
        file_id: "dashboard-file-3",
        filename: "source-3.pdf",
      },
    });
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledWith([], {
      conversationId,
      clientRequestId,
      attachmentReservation: {
        turnId,
        attachmentManifest,
      },
    });
    expect(mocks.onObservation).toHaveBeenCalledOnce();
    expect(mocks.onRecovered).toHaveBeenCalledOnce();
    expect(mocks.onCancelled).not.toHaveBeenCalled();
  });

  it("keeps a processing server upload in automatic recovery without asking for the browser file", async () => {
    const upload = unresolvedDiscoveryItem("receiving");
    const attachmentManifest = [{ ...manifestItem(1), ordinal: 1, total: 1 }];
    mocks.listManagedUploadsForKnowledgeBase.mockResolvedValue({
      uploads: [upload],
      reservation: {
        clientRequestId,
        sourceResetRevision: 7,
        attachmentManifest,
        stagedAttachmentCount: 0,
      },
    });
    mocks.recoverDiscoveredManagedUpload.mockResolvedValue({
      state: "processing",
      retryAfterMs: 10_000,
    });

    renderRecovery();

    await waitFor(() =>
      expect(mocks.recoverDiscoveredManagedUpload).toHaveBeenCalledOnce(),
    );
    expect(
      screen.getByText(
        "正在从 Dashboard 服务器恢复本批资料，无需重新发送已完成文件。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "选择未完成原文件" }),
    ).not.toBeInTheDocument();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.stageKnowledgeBaseTurnAttachment).not.toHaveBeenCalled();
    expect(mocks.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
  });

  it("offers browser reselection only after the server explicitly reports needs_browser_body", async () => {
    const upload = unresolvedDiscoveryItem("awaiting_browser");
    const attachmentManifest = [{ ...manifestItem(1), ordinal: 1, total: 1 }];
    mocks.listManagedUploadsForKnowledgeBase.mockResolvedValue({
      uploads: [upload],
      reservation: {
        clientRequestId,
        sourceResetRevision: 7,
        attachmentManifest,
        stagedAttachmentCount: 0,
      },
    });
    mocks.recoverDiscoveredManagedUpload.mockResolvedValue({
      state: "needs_browser_body",
    });

    renderRecovery();

    expect(
      await screen.findByRole("button", { name: "选择未完成原文件" }),
    ).toBeEnabled();
    expect(
      screen.getByText(
        "Dashboard 尚未完整收到：source-1.pdf。请只重新选择这些原文件。",
      ),
    ).toBeInTheDocument();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.stageKnowledgeBaseTurnAttachment).not.toHaveBeenCalled();
    expect(mocks.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
  });

  it("recreates only a missing intent inside the frozen reservation after exact-file reselection", async () => {
    const attachmentManifest = [
      {
        ...manifestItem(1),
        ordinal: 1,
        total: 1,
        sha256: "a".repeat(64),
      },
    ];
    const uploaded = {
      ...unresolvedDiscoveryItem("awaiting_browser"),
      state: "uploaded",
      phase: "uploaded",
      receipt: {
        fileId: "dashboard-file-recreated",
        sizeBytes: attachmentManifest[0]!.sizeBytes,
        uploadedAt: Date.now(),
        providerReadyAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
        replayed: false,
        recovered: false,
      },
    };
    mocks.listManagedUploadsForKnowledgeBase
      .mockResolvedValueOnce({
        uploads: [],
        reservation: {
          clientRequestId,
          sourceResetRevision: 7,
          attachmentManifest,
          stagedAttachmentCount: 0,
        },
      })
      .mockResolvedValueOnce({
        uploads: [uploaded],
        reservation: {
          clientRequestId,
          sourceResetRevision: 7,
          attachmentManifest,
          stagedAttachmentCount: 0,
        },
      });
    mocks.uploadFile.mockResolvedValue({
      fileId: "dashboard-file-recreated",
      filename: attachmentManifest[0]!.filename,
    });

    renderRecovery();

    expect(
      await screen.findByRole("button", { name: "选择未完成原文件" }),
    ).toBeEnabled();
    const bytes = new Uint8Array(attachmentManifest[0]!.sizeBytes);
    const file = new File([bytes], attachmentManifest[0]!.filename, {
      type: attachmentManifest[0]!.mimeType,
      lastModified: attachmentManifest[0]!.lastModified,
    });
    fireEvent.change(screen.getByLabelText("选择尚未 seal 的知识库原文件"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledOnce());
    expect(mocks.uploadFile.mock.calls[0]![3]).toEqual({
      captureLocalCopy: true,
      captureFilename: attachmentManifest[0]!.filename,
      batchId: clientRequestId,
      batchOrdinal: 1,
      batchTotal: 1,
      itemId: "item-1",
      resumeScope: {
        kind: "knowledge_base",
        conversationId,
        turnId,
        clientRequestId,
        expectedResetRevision: 7,
      },
    });
    await waitFor(() =>
      expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledOnce(),
    );
    expect(mocks.stageKnowledgeBaseTurnAttachment).toHaveBeenCalledWith({
      conversationId,
      turnId,
      clientRequestId,
      attachmentManifest,
      index: 0,
      attachment: {
        file_id: "dashboard-file-recreated",
        filename: attachmentManifest[0]!.filename,
      },
    });
  });

  it("cancels a production-like refreshed partial start by its persisted reset epoch", async () => {
    const awaiting = unresolvedDiscoveryItem("awaiting_browser");
    const uploaded = {
      ...uploadedDiscoveryItem(2),
      total: 2,
      clientRequestId,
    };
    const attachmentManifest = [
      { ...manifestItem(1), ordinal: 1, total: 2 },
      { ...manifestItem(2), ordinal: 2, total: 2 },
    ];
    awaiting.total = 2;
    mocks.listManagedUploadsForKnowledgeBase.mockResolvedValue({
      uploads: [awaiting, uploaded],
      reservation: {
        clientRequestId,
        sourceResetRevision: 9,
        attachmentManifest,
        stagedAttachmentCount: 0,
      },
    });
    mocks.recoverDiscoveredManagedUpload.mockResolvedValue({
      state: "needs_browser_body",
    });

    renderRecovery();
    const cancel = await screen.findByRole("button", {
      name: "取消本批次并重新选择",
    });
    fireEvent.click(cancel);

    await waitFor(() =>
      expect(mocks.cancelKnowledgeBaseStartReservation).toHaveBeenCalledWith({
        conversationId,
        turnId,
        clientRequestId,
        expectedResetRevision: 9,
      }),
    );
    expect(mocks.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
    expect(mocks.stageKnowledgeBaseTurnAttachment).not.toHaveBeenCalled();
    expect(mocks.discardManagedUploadIntent).toHaveBeenCalledTimes(2);
    expect(mocks.discardManagedUploadIntent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ intentId: "intent-1" }),
      { deferProviderCleanup: true },
    );
    expect(mocks.discardManagedUploadIntent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ intentId: "intent-2" }),
      { deferProviderCleanup: true },
    );
    expect(
      mocks.discardManagedUploadIntent.mock.calls.map(
        ([handle]) => handle.intentId,
      ),
    ).toEqual(["intent-1", "intent-2"]);
    expect(mocks.onCancelled).toHaveBeenCalledOnce();
    expect(mocks.onRecovered).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("knowledge-base-managed-upload-recovery"),
    ).not.toBeInTheDocument();
  });

  it("leaves immediately after revision cutover even when intent cleanup fails", async () => {
    const upload = unresolvedDiscoveryItem("awaiting_browser");
    const attachmentManifest = [{ ...manifestItem(1), ordinal: 1, total: 1 }];
    mocks.listManagedUploadsForKnowledgeBase.mockResolvedValue({
      uploads: [upload],
      reservation: {
        clientRequestId,
        sourceResetRevision: 9,
        attachmentManifest,
        stagedAttachmentCount: 0,
      },
    });
    mocks.recoverDiscoveredManagedUpload.mockResolvedValue({
      state: "needs_browser_body",
    });
    mocks.discardManagedUploadIntent.mockRejectedValueOnce(
      new Error("文件仍在清理"),
    );

    renderRecovery();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "取消本批次并重新选择",
      }),
    );

    await waitFor(() => expect(mocks.onCancelled).toHaveBeenCalledWith(10));
    expect(mocks.cancelKnowledgeBaseStartReservation).toHaveBeenCalledOnce();
    expect(mocks.discardManagedUploadIntent).toHaveBeenCalledOnce();
    expect(mocks.onRecovered).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("knowledge-base-managed-upload-recovery"),
    ).not.toBeInTheDocument();
  });
});
