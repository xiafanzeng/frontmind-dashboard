import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deliveryProjectHeaders, sanitizeBrandText } from "@/lib/frontmind-api";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PreparedStatus = "queued" | "processing" | "ready" | "failed";
type PreparedPhase =
  | "queued"
  | "downloading"
  | "sanitizing"
  | "optimizing"
  | "ready"
  | "failed";

interface PreparedPdfAsset {
  assetId: string;
  filename: string;
  mimeType: string;
  status: PreparedStatus;
  phase: PreparedPhase;
  size?: number;
  sourceBytes?: number;
  pageCount?: number;
  errorCode?: string;
  errorMessage?: string;
  retryAfterMs?: number;
  contentUrl: string;
  downloadTokenUrl: string;
}

interface PdfDocumentViewerProps {
  fileName: string;
  sourceUrl?: string;
  sourceFile?: Blob;
  onClose?: () => void;
}

const phaseLabels: Record<PreparedPhase, string> = {
  queued: "正在加载 PDF…",
  downloading: "正在加载 PDF…",
  sanitizing: "正在加载 PDF…",
  optimizing: "正在加载 PDF…",
  ready: "文件已准备完成",
  failed: "文件准备失败",
};

function nativeDownload(url: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

async function readApiError(response: Response) {
  try {
    const value = await response.json();
    return (
      value?.error?.message ||
      value?.message ||
      `请求失败 (HTTP ${response.status})`
    );
  } catch {
    return `请求失败 (HTTP ${response.status})`;
  }
}

async function prepareRemotePdf(
  fileUrl: string,
  fileName: string,
  signal?: AbortSignal,
) {
  const response = await fetch("/api/frontmind/assets/prepare", {
    method: "POST",
    credentials: "include",
    headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fileUrl, fileName }),
    signal,
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as PreparedPdfAsset;
}

async function fetchPreparedStatus(assetId: string, signal?: AbortSignal) {
  const response = await fetch(
    `/api/frontmind/assets/${encodeURIComponent(assetId)}/status`,
    {
      credentials: "include",
      cache: "no-store",
      signal,
      headers: deliveryProjectHeaders(),
    },
  );
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as PreparedPdfAsset;
}

function PageCanvas({
  document,
  pageNumber,
  scale,
  fitWidth,
  scrollRoot,
  onVisible,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  fitWidth: boolean;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  onVisible: (pageNumber: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(pageNumber <= 2);
  const [containerWidth, setContainerWidth] = useState(720);
  const [aspectRatio, setAspectRatio] = useState(1.414);

  useEffect(() => {
    const container = containerRef.current;
    const root = scrollRoot.current;
    if (!container || !root) return;
    const renderObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        setIsNearViewport(entry.isIntersecting);
      },
      { root, rootMargin: "900px 0px", threshold: 0 },
    );
    const visibleObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && entry.intersectionRatio >= 0.25) {
          onVisible(pageNumber);
        }
      },
      { root, threshold: [0.25, 0.6] },
    );
    renderObserver.observe(container);
    visibleObserver.observe(container);
    return () => {
      renderObserver.disconnect();
      visibleObserver.disconnect();
    };
  }, [onVisible, pageNumber, scrollRoot]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) setContainerWidth(width);
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textContainer = textLayerRef.current;
    if (!isNearViewport || !canvas || !textContainer) {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      if (textContainer) textContainer.replaceChildren();
      return;
    }

    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;

    void document
      .getPage(pageNumber)
      .then(async (loadedPage) => {
        if (cancelled) return;
        page = loadedPage;
        const baseViewport = loadedPage.getViewport({ scale: 1 });
        setAspectRatio(baseViewport.height / baseViewport.width);
        const targetScale = fitWidth
          ? Math.max(
              0.25,
              Math.min(
                3,
                (Math.max(containerWidth, 320) - 32) / baseViewport.width,
              ),
            )
          : scale;
        const viewport = loadedPage.getViewport({ scale: targetScale });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("浏览器无法创建 PDF Canvas");

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        renderTask = loadedPage.render({
          canvasContext: context,
          viewport,
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await renderTask.promise;
        if (cancelled) return;

        textContainer.replaceChildren();
        textContainer.style.width = `${Math.floor(viewport.width)}px`;
        textContainer.style.height = `${Math.floor(viewport.height)}px`;
        textLayer = new TextLayer({
          textContentSource: loadedPage.streamTextContent(),
          container: textContainer,
          viewport,
        });
        await textLayer.render();
      })
      .catch((error) => {
        if (
          !cancelled &&
          error?.name !== "RenderingCancelledException" &&
          error?.name !== "AbortException"
        ) {
          console.error(`[PDF] Failed to render page ${pageNumber}`, error);
        }
      });

    return () => {
      cancelled = true;
      textLayer?.cancel();
      renderTask?.cancel();
      page?.cleanup();
    };
  }, [containerWidth, document, fitWidth, isNearViewport, pageNumber, scale]);

  const placeholderHeight = Math.max(
    420,
    Math.round(Math.max(320, containerWidth - 32) * aspectRatio),
  );

  return (
    <div
      ref={containerRef}
      id={`pdf-page-${pageNumber}`}
      className="relative flex min-h-[420px] w-full justify-center px-4 py-3"
      style={{ minHeight: placeholderHeight }}
      aria-label={`第 ${pageNumber} 页`}
    >
      {isNearViewport ? (
        <div className="relative h-fit max-w-full overflow-hidden bg-white shadow-md">
          <canvas ref={canvasRef} className="block max-w-full" />
          <div
            ref={textLayerRef}
            className="textLayer absolute inset-0 overflow-hidden opacity-100"
          />
        </div>
      ) : (
        <div className="flex h-full min-h-[360px] w-[min(90%,720px)] items-center justify-center rounded-sm bg-white shadow-sm">
          <span className="text-xs text-slate-400">第 {pageNumber} 页</span>
        </div>
      )}
    </div>
  );
}

export default function PdfDocumentViewer({
  fileName,
  sourceUrl,
  sourceFile,
  onClose,
}: PdfDocumentViewerProps) {
  const displayName = sanitizeBrandText(fileName || "document.pdf");
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [asset, setAsset] = useState<PreparedPdfAsset | null>(null);
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.15);
  const [fitWidth, setFitWidth] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [isDownloading, setIsDownloading] = useState(false);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isLocalSource =
    Boolean(sourceFile) ||
    Boolean(sourceUrl?.startsWith("blob:")) ||
    Boolean(sourceUrl?.startsWith("data:"));

  useEffect(() => {
    if (!sourceFile) {
      setLocalUrl(null);
      return;
    }
    const url = URL.createObjectURL(sourceFile);
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [sourceFile]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const load = async () => {
      setLoadingError(null);
      setPdfDocument(null);
      setAsset(null);
      setDocumentUrl(null);

      if (isLocalSource) {
        setDocumentUrl(localUrl || sourceUrl || null);
        return;
      }
      if (!sourceUrl) {
        setLoadingError("没有可用的 PDF 文件地址");
        return;
      }

      try {
        let next = await prepareRemotePdf(
          sourceUrl,
          displayName,
          controller.signal,
        );
        if (cancelled) return;
        setAsset(next);
        const startedAt = Date.now();

        const poll = async () => {
          if (cancelled) return;
          if (next.status === "ready") {
            setDocumentUrl(next.contentUrl);
            return;
          }
          if (next.status === "failed") {
            setLoadingError(next.errorMessage || "PDF 文件准备失败");
            return;
          }
          const elapsed = Date.now() - startedAt;
          const delay =
            elapsed < 10_000 ? 1_000 : elapsed < 30_000 ? 2_000 : 5_000;
          timer = setTimeout(async () => {
            try {
              next = await fetchPreparedStatus(next.assetId, controller.signal);
              if (cancelled) return;
              setAsset(next);
              await poll();
            } catch (error) {
              if (!cancelled) {
                setLoadingError(
                  error instanceof Error ? error.message : "查询文件状态失败",
                );
              }
            }
          }, delay);
        };
        await poll();
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          setLoadingError(
            error instanceof Error ? error.message : "PDF 文件准备失败",
          );
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [displayName, isLocalSource, localUrl, prepareAttempt, sourceUrl]);

  useEffect(() => {
    if (!documentUrl) return;
    setLoadingError(null);
    const loadingTask = getDocument({
      url: documentUrl,
      withCredentials: true,
      httpHeaders: deliveryProjectHeaders(),
      rangeChunkSize: 256 * 1024,
    });
    let cancelled = false;
    void loadingTask.promise
      .then((document) => {
        if (cancelled) {
          void document.destroy();
          return;
        }
        setPdfDocument(document);
        setCurrentPage(1);
        setPageInput("1");
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadingError(error?.message || "PDF 解析失败");
        }
      });
    return () => {
      cancelled = true;
      setPdfDocument(null);
      void loadingTask.destroy();
    };
  }, [documentUrl]);

  const visiblePageChanged = useCallback((page: number) => {
    setCurrentPage(page);
    setPageInput(String(page));
  }, []);

  const goToPage = useCallback(
    (page: number) => {
      if (!pdfDocument) return;
      const next = Math.max(1, Math.min(pdfDocument.numPages, page));
      document
        .getElementById(`pdf-page-${next}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      setCurrentPage(next);
      setPageInput(String(next));
    },
    [pdfDocument],
  );

  const retryPreparation = useCallback(async () => {
    if (!asset) return;
    setLoadingError(null);
    const response = await fetch(
      `/api/frontmind/assets/${encodeURIComponent(asset.assetId)}/retry`,
      {
        method: "POST",
        credentials: "include",
        headers: deliveryProjectHeaders(),
      },
    );
    if (!response.ok) {
      setLoadingError(await readApiError(response));
      return;
    }
    const next = (await response.json()) as PreparedPdfAsset;
    setAsset(next);
    setPrepareAttempt((value) => value + 1);
  }, [asset]);

  const handleDownload = useCallback(async () => {
    setIsDownloading(true);
    try {
      if (isLocalSource) {
        const url = localUrl || sourceUrl;
        if (!url) throw new Error("没有可下载的文件");
        nativeDownload(url, displayName);
        return;
      }
      if (!asset || asset.status !== "ready") {
        throw new Error("文件仍在准备中");
      }
      const response = await fetch(asset.downloadTokenUrl, {
        method: "POST",
        credentials: "include",
        headers: deliveryProjectHeaders(),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const value = await response.json();
      if (!value.downloadUrl) throw new Error("下载链接无效");
      nativeDownload(value.downloadUrl, displayName);
    } catch (error) {
      setLoadingError(error instanceof Error ? error.message : "文件下载失败");
    } finally {
      setIsDownloading(false);
    }
  }, [asset, displayName, isLocalSource, localUrl, sourceUrl]);

  const pageNumbers = useMemo(
    () =>
      pdfDocument
        ? Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1)
        : [],
    [pdfDocument],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-2">
        <div className="mr-auto flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-primary" />
          <span className="max-w-[300px] truncate text-sm font-medium">
            {displayName}
          </span>
        </div>

        {pdfDocument && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              aria-label="上一页"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Input
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") goToPage(Number(pageInput));
                }}
                className="h-7 w-12 px-1 text-center text-xs"
                aria-label="页码"
              />
              <span>/ {pdfDocument.numPages}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= pdfDocument.numPages}
              aria-label="下一页"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => {
                setFitWidth(false);
                setScale((value) => Math.max(0.4, value - 0.15));
              }}
              aria-label="缩小"
            >
              <Minus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => {
                setFitWidth(false);
                setScale((value) => Math.min(3, value + 0.15));
              }}
              aria-label="放大"
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Button
              variant={fitWidth ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setFitWidth((value) => !value)}
              aria-label="适应宽度"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 text-xs"
          onClick={() => void handleDownload()}
          disabled={isDownloading || Boolean(asset && asset.status !== "ready")}
        >
          {isDownloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          下载
        </Button>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onClose}
            aria-label="关闭 PDF"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-muted/35">
        {loadingError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <FileText className="h-12 w-12 text-muted-foreground/30" />
            <p className="text-sm font-medium">PDF 加载失败</p>
            <p className="max-w-md text-xs text-muted-foreground">
              {loadingError}
            </p>
            {asset?.status === "failed" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void retryPreparation()}
              >
                <RotateCcw className="mr-1 h-4 w-4" />
                重新准备
              </Button>
            )}
          </div>
        ) : !pdfDocument ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary/50" />
            <p className="text-sm text-muted-foreground">
              {asset ? phaseLabels[asset.phase] : "正在打开 PDF…"}
            </p>
            {asset?.sourceBytes ? (
              <p className="text-xs text-muted-foreground/70">
                已接收 {(asset.sourceBytes / 1024 / 1024).toFixed(1)} MB
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[1500px]">
            {pageNumbers.map((pageNumber) => (
              <PageCanvas
                key={pageNumber}
                document={pdfDocument}
                pageNumber={pageNumber}
                scale={scale}
                fitWidth={fitWidth}
                scrollRoot={scrollRef}
                onVisible={visiblePageChanged}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
