import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  normalizedKnowledgeBaseUploadFilename,
  normalizedKnowledgeBaseUploadMimeType,
  sha256UploadFile,
} from "@/lib/attachment-files";
import {
  createKnowledgeBaseTurnTask,
  listManagedUploadsForKnowledgeBase,
  recoverDiscoveredManagedUpload,
  stageKnowledgeBaseTurnAttachment,
  uploadFile,
  type KnowledgeBaseAttachmentManifestItem,
  type ManagedUploadDiscovery,
  type ManagedUploadDiscoveryItem,
  type ManagedUploadHandle,
  type UploadRetentionReceipt,
} from "@/lib/frontmind-api";
import type { KnowledgeBaseObservationDto } from "@/lib/knowledge-progress";

type MissingUpload = {
  upload: ManagedUploadDiscoveryItem | null;
  manifest: KnowledgeBaseAttachmentManifestItem;
  index: number;
  clientRequestId: string;
  total: number;
};

type RecoveryPhase =
  | "discovering"
  | "restoring"
  | "needs_browser"
  | "dispatching"
  | "attention";

function orderedRecoveryBatch(discovery: ManagedUploadDiscovery) {
  const { uploads, reservation } = discovery;
  const manifest = reservation.attachmentManifest;
  if (
    manifest.length < 1 ||
    uploads.length > manifest.length ||
    reservation.stagedAttachmentCount < 0 ||
    reservation.stagedAttachmentCount > manifest.length
  ) {
    throw new Error("服务器上传批次与知识库预约不一致");
  }
  const uploadsByOrdinal = new Map<number, ManagedUploadDiscoveryItem>();
  uploads.forEach((upload) => {
    const index = upload.ordinal - 1;
    const item = manifest[index];
    if (
      !item ||
      !Number.isSafeInteger(upload.ordinal) ||
      uploadsByOrdinal.has(upload.ordinal) ||
      upload.total !== manifest.length ||
      upload.clientRequestId !== reservation.clientRequestId ||
      upload.filename !== item.filename ||
      upload.sizeBytes !== item.sizeBytes ||
      upload.mimeType !== item.mimeType
    ) {
      throw new Error("服务器上传文件顺序与冻结清单不一致");
    }
    uploadsByOrdinal.set(upload.ordinal, upload);
  });
  return manifest.map((item, index) => ({
    upload: uploadsByOrdinal.get(index + 1) ?? null,
    manifest: item,
    index,
    clientRequestId: reservation.clientRequestId,
    total: manifest.length,
  }));
}

function receiptFromDiscovery(upload: ManagedUploadDiscoveryItem) {
  if (upload.state !== "uploaded" || !upload.receipt?.fileId) return null;
  return {
    ...upload.receipt,
    recovered: true,
  } satisfies UploadRetentionReceipt;
}

function discoveredUploadHandle(
  upload: ManagedUploadDiscoveryItem,
  manifest: KnowledgeBaseAttachmentManifestItem,
): ManagedUploadHandle {
  return {
    intentId: upload.intentId,
    itemId: manifest.itemId || upload.batchId,
    filename: upload.filename,
    ticket: upload.intentTicket,
    expiresAt: upload.ticketExpiresAt,
    operationId: manifest.itemId || upload.batchId,
  };
}

function frozenBatchIdForMissingUpload(target: MissingUpload) {
  if (target.upload?.batchId) return target.upload.batchId;
  const suffix = `:${target.index + 1}`;
  const itemId = target.manifest.itemId || "";
  return itemId.endsWith(suffix) && itemId.length > suffix.length
    ? itemId.slice(0, -suffix.length)
    : target.clientRequestId;
}

export default function KnowledgeBaseManagedUploadRecovery({
  conversationId,
  turnId,
  onObservation,
  onRecovered,
}: {
  conversationId: string;
  turnId: string;
  onObservation: (observation: KnowledgeBaseObservationDto) => void;
  onRecovered?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const runningRef = useRef(false);
  const onObservationRef = useRef(onObservation);
  const onRecoveredRef = useRef(onRecovered);
  const [phase, setPhase] = useState<RecoveryPhase>("discovering");
  const [missing, setMissing] = useState<MissingUpload[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [manualUpload, setManualUpload] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missingNames = useMemo(
    () => missing.map(({ manifest }) => manifest.filename).join("、"),
    [missing],
  );

  useEffect(() => {
    onObservationRef.current = onObservation;
    onRecoveredRef.current = onRecovered;
  }, [onObservation, onRecovered]);

  useEffect(() => {
    if (!conversationId || !turnId || manualUpload || runningRef.current)
      return;
    const controller = new AbortController();
    let retryTimer: number | undefined;
    runningRef.current = true;

    const run = async () => {
      try {
        setError(null);
        setPhase("discovering");
        const discovery = await listManagedUploadsForKnowledgeBase({
          conversationId,
          turnId,
          signal: controller.signal,
        });
        const ordered = orderedRecoveryBatch(discovery);
        const recovery = await Promise.all(
          ordered.map(async ({ upload }, index) => {
            if (index < discovery.reservation.stagedAttachmentCount) {
              return {
                receipt: null,
                needsBrowserBody: false,
                retryAfterMs: 0,
                alreadyStaged: true,
              };
            }
            if (!upload) {
              return {
                receipt: null,
                needsBrowserBody: true,
                retryAfterMs: 0,
                alreadyStaged: false,
              };
            }
            const existing = receiptFromDiscovery(upload);
            if (existing) {
              return {
                receipt: existing,
                needsBrowserBody: false,
                retryAfterMs: 0,
                alreadyStaged: false,
              };
            }
            setPhase("restoring");
            const recovered = await recoverDiscoveredManagedUpload(upload, {
              signal: controller.signal,
            });
            if (recovered.state === "uploaded") {
              return {
                receipt: recovered.receipt,
                needsBrowserBody: false,
                retryAfterMs: 0,
                alreadyStaged: false,
              };
            }
            return {
              receipt: null,
              needsBrowserBody: recovered.state === "needs_browser_body",
              retryAfterMs:
                recovered.state === "processing"
                  ? recovered.retryAfterMs
                  : 3_000,
              alreadyStaged: false,
            };
          }),
        );
        if (controller.signal.aborted) return;

        const unresolved = ordered
          .map((item, index) =>
            recovery[index]?.receipt || recovery[index]?.alreadyStaged
              ? null
              : item,
          )
          .filter((item): item is MissingUpload => Boolean(item));
        const requiresBrowser = unresolved.filter(
          ({ index }) => recovery[index]?.needsBrowserBody === true,
        );
        if (requiresBrowser.length > 0) {
          setMissing(requiresBrowser);
          setPhase("needs_browser");
          return;
        }
        if (unresolved.length > 0) {
          setMissing([]);
          setPhase("restoring");
          const retryAfterMs = Math.max(
            500,
            Math.min(
              10_000,
              ...recovery
                .filter((item) => !item.receipt && item.alreadyStaged !== true)
                .map((item) => item.retryAfterMs || 3_000),
            ),
          );
          retryTimer = window.setTimeout(
            () => setRefreshToken((value) => value + 1),
            retryAfterMs,
          );
          return;
        }

        const receipts = recovery.map((item) => item.receipt);
        if (
          receipts
            .slice(discovery.reservation.stagedAttachmentCount)
            .some((receipt) => !receipt)
        ) {
          throw new Error("Dashboard 上传恢复回执不完整");
        }

        setMissing([]);
        setPhase("dispatching");
        for (
          let index = discovery.reservation.stagedAttachmentCount;
          index < ordered.length;
          index += 1
        ) {
          const receipt = receipts[index]!;
          await stageKnowledgeBaseTurnAttachment({
            conversationId,
            turnId,
            clientRequestId: discovery.reservation.clientRequestId,
            attachmentManifest: discovery.reservation.attachmentManifest,
            index,
            attachment: {
              file_id: receipt.fileId,
              filename: ordered[index]!.manifest.filename,
            },
          });
        }
        const result = await createKnowledgeBaseTurnTask([], {
          conversationId,
          clientRequestId: discovery.reservation.clientRequestId,
          attachmentReservation: {
            turnId,
            attachmentManifest: discovery.reservation.attachmentManifest,
          },
        });
        if (result.knowledgeObservation) {
          onObservationRef.current(result.knowledgeObservation);
        }
        onRecoveredRef.current?.();
        toast.success("资料已从 Dashboard 恢复并继续构建", {
          description: "本次恢复没有再次发送已经 seal 的浏览器文件体。",
        });
      } catch (caught) {
        if (controller.signal.aborted) return;
        setPhase("attention");
        setError(
          caught instanceof Error ? caught.message : "上传恢复暂时不可用",
        );
      } finally {
        runningRef.current = false;
      }
    };
    void run();
    return () => {
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      runningRef.current = false;
    };
  }, [conversationId, manualUpload, refreshToken, turnId]);

  const selectMissingFiles = useCallback(
    async (fileList: FileList | null) => {
      const selected = Array.from(fileList || []);
      if (selected.length === 0 || manualUpload) return;
      setManualUpload(true);
      setError(null);
      try {
        const remaining = [...missing];
        const matched: Array<{ file: File; missing: MissingUpload }> = [];
        for (const file of selected) {
          const filename = normalizedKnowledgeBaseUploadFilename(file.name);
          const mimeType = normalizedKnowledgeBaseUploadMimeType(file);
          const sha256 = await sha256UploadFile(file);
          const index = remaining.findIndex(
            ({ manifest }) =>
              manifest.filename === filename &&
              manifest.sizeBytes === file.size &&
              manifest.mimeType === mimeType &&
              manifest.sha256 === sha256,
          );
          if (index < 0) {
            throw new Error(`所选文件与待恢复清单不一致：${file.name}`);
          }
          const target = remaining.splice(index, 1)[0]!;
          matched.push({ file, missing: target });
        }
        for (const { file, missing: target } of matched) {
          await uploadFile(file, undefined, undefined, {
            captureLocalCopy: true,
            captureFilename: target.manifest.filename,
            batchId: frozenBatchIdForMissingUpload(target),
            batchOrdinal: target.index + 1,
            batchTotal: target.total,
            itemId: target.manifest.itemId,
            resumeScope: {
              kind: "knowledge_base",
              conversationId,
              turnId,
              clientRequestId: target.clientRequestId,
            },
            ...(target.upload
              ? {
                  existingUploadHandle: discoveredUploadHandle(
                    target.upload,
                    target.manifest,
                  ),
                }
              : {}),
          });
        }
        setMissing((current) =>
          current.filter(
            (candidate) =>
              !matched.some(
                ({ missing: completed }) => completed.index === candidate.index,
              ),
          ),
        );
        setRefreshToken((value) => value + 1);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "文件恢复暂时不可用",
        );
      } finally {
        setManualUpload(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [conversationId, manualUpload, missing, turnId],
  );

  return (
    <div
      className="mt-3 w-full rounded-lg border border-amber-300/80 bg-white/70 p-3 text-amber-950"
      data-testid="knowledge-base-managed-upload-recovery"
    >
      <p className="text-xs leading-5">
        {phase === "needs_browser"
          ? `Dashboard 尚未完整收到：${missingNames}。请只重新选择这些原文件。`
          : phase === "attention"
            ? "Dashboard 暂时无法自动恢复本批资料；已完成内容和服务器副本不受影响。"
            : phase === "dispatching"
              ? "资料已恢复，正在继续原知识库轮次。"
              : "正在从 Dashboard 服务器恢复本批资料，无需重新发送已完成文件。"}
      </p>
      {error && <p className="mt-1 text-xs text-amber-800">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label="选择尚未 seal 的知识库原文件"
        disabled={manualUpload}
        onChange={(event) => void selectMissingFiles(event.currentTarget.files)}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {phase === "needs_browser" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={manualUpload}
            onClick={() => inputRef.current?.click()}
          >
            {manualUpload ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1.5 h-3.5 w-3.5" />
            )}
            选择未完成原文件
          </Button>
        ) : (
          <span className="inline-flex items-center text-xs">
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            自动恢复中
          </span>
        )}
        {phase === "attention" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setPhase("discovering");
              setRefreshToken((value) => value + 1);
            }}
          >
            重新检查服务器副本
          </Button>
        )}
      </div>
    </div>
  );
}
