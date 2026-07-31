/**
 * FilePreview Component - Preview and download files
 * Features: File type icon, file info, download button, inline PDF viewer,
 *           HTML file rendering, text file preview.
 */
import { lazy, Suspense, useCallback, useState, useEffect } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  FileText,
  File,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileImage,
  Download,
  X,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { deliveryProjectHeaders, sanitizeBrandText } from "@/lib/frontmind-api";
import type { Attachment } from "@/contexts/ConversationContext";

const PdfDocumentViewer = lazy(() => import("./PdfDocumentViewer"));

interface FilePreviewProps {
  file: Attachment;
  className?: string;
  showDownload?: boolean;
}

// Get file icon based on MIME type
function getFileIcon(mimeType: string | undefined, fileName: string) {
  if (mimeType?.startsWith("image/")) return FileImage;
  if (mimeType?.startsWith("video/")) return File;
  if (mimeType?.startsWith("audio/")) return File;
  if (mimeType?.includes("pdf")) return FileText;
  if (
    mimeType?.includes("zip") ||
    mimeType?.includes("tar") ||
    mimeType?.includes("rar")
  )
    return FileArchive;
  if (
    mimeType?.includes("json") ||
    mimeType?.includes("xml") ||
    mimeType?.includes("html") ||
    mimeType?.includes("css") ||
    mimeType?.includes("javascript")
  )
    return FileCode;
  if (
    mimeType?.includes("sheet") ||
    mimeType?.includes("excel") ||
    mimeType?.includes("csv")
  )
    return FileSpreadsheet;
  if (mimeType?.includes("word") || mimeType?.includes("document"))
    return FileText;

  const ext = fileName.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf":
      return FileText;
    case "zip":
    case "tar":
    case "gz":
    case "rar":
    case "7z":
      return FileArchive;
    case "js":
    case "ts":
    case "jsx":
    case "tsx":
    case "py":
    case "java":
    case "c":
    case "cpp":
    case "h":
    case "css":
    case "html":
    case "json":
    case "xml":
      return FileCode;
    case "xls":
    case "xlsx":
    case "csv":
      return FileSpreadsheet;
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
    case "svg":
      return FileImage;
    default:
      return File;
  }
}

// Format file size
function formatFileSize(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function isPdfFile(mimeType: string | undefined, fileName: string): boolean {
  if (mimeType?.includes("pdf")) return true;
  const ext = fileName.split(".").pop()?.toLowerCase();
  return ext === "pdf";
}

function isHtmlFile(mimeType: string | undefined, fileName: string): boolean {
  if (mimeType?.includes("html")) return true;
  const ext = fileName.split(".").pop()?.toLowerCase();
  return ext === "html" || ext === "htm";
}

function isPreviewableFile(
  mimeType: string | undefined,
  fileName: string,
): boolean {
  return isPdfFile(mimeType, fileName) || isHtmlFile(mimeType, fileName);
}

function buildProxyDownloadUrl(
  fileUrl: string,
  fileName?: string,
  asDownload = false,
): string | null {
  try {
    const parsed = new URL(fileUrl, window.location.origin);
    if (parsed.pathname.endsWith("/api/frontmind/proxy-download")) {
      if (fileName)
        parsed.searchParams.set("filename", sanitizeBrandText(fileName));
      if (asDownload) parsed.searchParams.set("download", "1");
      return `${parsed.pathname}${parsed.search}`;
    }
    if (/^https?:\/\//i.test(fileUrl)) {
      const params = new URLSearchParams({ url: fileUrl });
      if (fileName) params.set("filename", sanitizeBrandText(fileName));
      if (asDownload) params.set("download", "1");
      return `/api/frontmind/proxy-download?${params.toString()}`;
    }
  } catch {
    // Ignore malformed URLs.
  }
  return null;
}

function nativeDownload(url: string, fileName: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Fetch a file from the API with proper auth headers and return a blob URL.
 * This is needed because iframe src can't send custom headers.
 *
 * The server proxy at /api/frontmind/v1/files/:id now:
 * 1. Fetches file metadata from FrontMind API
 * 2. Uses the upload_url (S3) to download binary content
 * 3. Returns binary content with correct content-type
 *
 * As a safety fallback, if we still get JSON metadata, we extract
 * the upload_url and fetch from S3 via the proxy-download endpoint.
 */
async function fetchFileAsBlob(
  fileId: string,
  fileName?: string,
): Promise<string> {
  const url =
    buildProxyDownloadUrl(fileId, fileName, false) ||
    `/api/frontmind/v1/files/${fileId}`;

  const response = await fetch(url, {
    credentials: "include",
    headers: deliveryProjectHeaders(),
  });

  if (!response.ok) {
    throw new Error(`文件读取失败（HTTP ${response.status}）`);
  }

  // Safety check: if we got JSON metadata instead of binary content
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      if (data.upload_url) {
        // Got metadata - fetch binary from S3 via proxy
        const proxyUrl =
          buildProxyDownloadUrl(data.upload_url, fileName, false) ||
          `/api/frontmind/proxy-download?url=${encodeURIComponent(data.upload_url)}`;
        const s3Response = await fetch(proxyUrl, {
          credentials: "include",
          headers: deliveryProjectHeaders(),
        });
        if (!s3Response.ok) {
          throw new Error(`S3 download failed: HTTP ${s3Response.status}`);
        }
        const blob = await s3Response.blob();
        return URL.createObjectURL(blob);
      }
    } catch {
      // Not valid JSON or no upload_url
    }
    throw new Error("服务返回了文件信息，但未返回文件内容");
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

async function createDirectDownloadUrl(fileId: string): Promise<string> {
  const response = await fetch("/api/frontmind/download-token", {
    method: "POST",
    headers: deliveryProjectHeaders({
      "Content-Type": "application/json",
    }),
    credentials: "include",
    body: JSON.stringify({ fileId }),
  });

  if (!response.ok) {
    throw new Error(`下载链接创建失败（HTTP ${response.status}）`);
  }

  const data = await response.json();
  if (!data.downloadUrl) {
    throw new Error("下载链接响应缺少有效地址");
  }
  return data.downloadUrl;
}

export default function FilePreview({
  file,
  className,
  showDownload = true,
}: FilePreviewProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const displayFileName = sanitizeBrandText(file.name || "file");
  const Icon = getFileIcon(file.file?.type, displayFileName);
  const fileSize = file.file?.size ? formatFileSize(file.file.size) : "";
  const isPdf = isPdfFile(file.file?.type, displayFileName);
  const isPreviewable = isPreviewableFile(file.file?.type, displayFileName);

  // Load a blob URL only for non-PDF iframe previews.
  // Priority: blobUrl (in-memory) > File object > base64 (convert to blob) > API fileId
  useEffect(() => {
    if (isOpen && isPreviewable && !isPdf) {
      setLoadingPreview(true);
      setPreviewError(null);

      if (file.blobUrl) {
        // In-memory blob URL (for large files)
        setBlobUrl(file.blobUrl);
        setLoadingPreview(false);
      } else if (file.file) {
        // Local File object - create blob URL
        setBlobUrl(URL.createObjectURL(file.file));
        setLoadingPreview(false);
      } else if (file.base64) {
        // Convert a base64 HTML data URL to a blob URL for sandboxed rendering.
        try {
          const parts = file.base64.split(",");
          const mimeMatch = parts[0]?.match(/:(.*?);/);
          const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
          const binaryStr = atob(parts[1]);
          const bytes = new Uint8Array(binaryStr.length);
          for (let j = 0; j < binaryStr.length; j++) {
            bytes[j] = binaryStr.charCodeAt(j);
          }
          const blob = new Blob([bytes], { type: mime });
          setBlobUrl(URL.createObjectURL(blob));
        } catch (e) {
          console.error("Failed to convert base64 to blob:", e);
          setPreviewError("文件格式转换失败");
        }
        setLoadingPreview(false);
      } else if (file.fileId) {
        const proxyUrl = buildProxyDownloadUrl(
          file.fileId,
          displayFileName,
          false,
        );
        if (proxyUrl) {
          fetchFileAsBlob(proxyUrl, displayFileName)
            .then((url) => {
              setBlobUrl(url);
              setLoadingPreview(false);
            })
            .catch((err) => {
              console.error("Failed to load proxied file preview:", err);
              setPreviewError(err.message);
              setLoadingPreview(false);
            });
        } else {
          // Fetch from API (works for uploaded files with real file IDs)
          fetchFileAsBlob(file.fileId, displayFileName)
            .then((url) => {
              setBlobUrl(url);
              setLoadingPreview(false);
            })
            .catch((err) => {
              console.error("Failed to load file preview:", err);
              setPreviewError(err.message);
              setLoadingPreview(false);
            });
        }
      } else {
        setPreviewError("没有可用的文件来源");
        setLoadingPreview(false);
      }
    }

    // Cleanup blob URL when dialog closes
    return () => {
      if (blobUrl && blobUrl.startsWith("blob:")) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [
    isOpen,
    file.fileId,
    file.file,
    file.base64,
    file.blobUrl,
    isPreviewable,
    isPdf,
    displayFileName,
  ]);

  const handleDownload = useCallback(async () => {
    if (isPdf) {
      // Remote PDFs must finish server-side brand replacement before download.
      // Opening the shared viewer starts/previews that preparation and exposes
      // the download action only when the sanitized asset is ready.
      setIsOpen(true);
      return;
    }
    setIsDownloading(true);
    try {
      let downloadName = displayFileName;

      // Priority: blobUrl > File object > base64 > API fileId
      if (file.blobUrl) {
        // In-memory blob URL (for large files)
        nativeDownload(file.blobUrl, downloadName);
        return;
      }

      if (file.file) {
        // Local File object (available in current session)
        const objectUrl = URL.createObjectURL(file.file);
        nativeDownload(objectUrl, downloadName);
        URL.revokeObjectURL(objectUrl);
        return;
      }

      if (file.base64) {
        // Direct base64/data-URL download
        nativeDownload(file.base64, downloadName);
        return;
      }

      if (file.fileId) {
        const proxiedExternalUrl = buildProxyDownloadUrl(
          file.fileId,
          downloadName,
          true,
        );
        if (proxiedExternalUrl) {
          const blobUrl = await fetchFileAsBlob(
            proxiedExternalUrl,
            downloadName,
          );
          nativeDownload(blobUrl, downloadName);
          URL.revokeObjectURL(blobUrl);
          return;
        }

        // Fast path for uploaded files with real file IDs: create a short-lived
        // same-origin URL and let the browser download natively. This avoids
        // the slow fetch->Blob->ObjectURL path and improves security prompts.
        try {
          const directUrl = await createDirectDownloadUrl(file.fileId);
          nativeDownload(directUrl, downloadName);
          return;
        } catch (err) {
          console.error("Direct download failed:", err);
        }
      }

      console.error("No file source available for download");
    } catch (err) {
      console.error("Download failed:", err);
    } finally {
      setIsDownloading(false);
    }
  }, [file, displayFileName, isPdf]);

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-2.5 px-3 py-2.5 rounded-2xl bg-card/80 border border-border/70 shadow-sm",
          "hover:bg-secondary/70 hover:border-primary/25 transition-all cursor-pointer group",
          className,
        )}
        onClick={() => setIsOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setIsOpen(true)}
      >
        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Icon className="w-4 h-4 text-primary/60" />
        </div>
        <div className="flex-1 overflow-hidden">
          <p className="text-xs font-medium text-foreground/70 truncate">
            {displayFileName}
          </p>
          {fileSize && (
            <p className="text-xs text-muted-foreground/50">{fileSize}</p>
          )}
        </div>
        {showDownload && (
          <Button
            variant="ghost"
            size="icon"
            className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              handleDownload();
            }}
          >
            {isDownloading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
          </Button>
        )}
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent
          showCloseButton={false}
          className={cn(
            "p-0 flex flex-col overflow-hidden",
            isPreviewable ? "sm:max-w-[800px]" : "max-w-md",
          )}
          style={
            isPreviewable
              ? { width: 800, height: 640, maxWidth: "95vw", maxHeight: "95vh" }
              : undefined
          }
        >
          <DialogTitle className="sr-only">{displayFileName}</DialogTitle>

          {isPdf ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  正在启动 PDF 阅读器…
                </div>
              }
            >
              <PdfDocumentViewer
                fileName={displayFileName}
                sourceFile={file.file}
                sourceUrl={
                  file.blobUrl ||
                  file.base64 ||
                  (file.fileId
                    ? buildProxyDownloadUrl(
                        file.fileId,
                        displayFileName,
                        false,
                      ) ||
                      (file.fileId.startsWith("/") ||
                      /^https?:\/\//i.test(file.fileId)
                        ? file.fileId
                        : `/api/frontmind/v1/files/${encodeURIComponent(file.fileId)}`)
                    : undefined)
                }
                onClose={() => setIsOpen(false)}
              />
            </Suspense>
          ) : isPreviewable ? (
            <>
              {/* Previewable file header */}
              <div className="flex items-center justify-between px-6 py-3 border-b border-border/30 flex-shrink-0">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium text-foreground/80 truncate max-w-[400px]">
                    {displayFileName}
                  </span>
                  {fileSize && (
                    <span className="text-xs text-muted-foreground/50 ml-1">
                      {fileSize}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleDownload}
                    disabled={isDownloading}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {isDownloading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5" />
                    )}
                    下载
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setIsOpen(false)}
                    className="w-8 h-8"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              {/* File preview area */}
              <div className="flex-1 overflow-hidden bg-muted/20">
                {loadingPreview ? (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="w-8 h-8 animate-spin text-primary/50" />
                    <span className="ml-2 text-sm text-muted-foreground">
                      加载文件中...
                    </span>
                  </div>
                ) : previewError ? (
                  <div className="flex flex-col items-center justify-center h-full gap-3">
                    <FileText className="w-12 h-12 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">
                      文件加载失败
                    </p>
                    <p className="text-xs text-muted-foreground/60">
                      {previewError}
                    </p>
                    <Button
                      onClick={handleDownload}
                      variant="outline"
                      size="sm"
                    >
                      <Download className="w-4 h-4 mr-1" />
                      直接下载
                    </Button>
                  </div>
                ) : blobUrl ? (
                  <iframe
                    src={blobUrl}
                    title={displayFileName}
                    className="w-full h-full border-0"
                    style={{ minHeight: "100%" }}
                    sandbox=""
                  />
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center py-6">
              {/* Large icon */}
              <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
                <Icon className="w-10 h-10 text-primary/60" />
              </div>

              {/* File info */}
              <h3 className="text-lg font-semibold text-foreground text-center mb-1">
                {displayFileName}
              </h3>
              {fileSize && (
                <p className="text-sm text-muted-foreground mb-4">{fileSize}</p>
              )}

              {/* Actions - only download */}
              <div className="flex items-center gap-3 mt-2">
                {showDownload && (
                  <Button onClick={handleDownload} disabled={isDownloading}>
                    {isDownloading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        下载中...
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        下载文件
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
