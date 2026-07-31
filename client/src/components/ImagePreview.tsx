/**
 * ImagePreview Component - Full-screen image viewer with zoom and pan
 * Features: Click to open fullscreen modal, zoom controls, download
 *
 * FIX: Now properly handles API URLs with auth headers for download/preview.
 * Supports both /api/frontmind/v1/files/ URLs and /api/frontmind/proxy-download URLs.
 */
import { useState, useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, RotateCw, Download, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { deliveryProjectHeaders } from "@/lib/frontmind-api";

interface ImagePreviewProps {
  src: string;
  alt?: string;
  className?: string;
  showDownload?: boolean;
}

/**
 * Check if a URL needs auth headers (our proxy URLs)
 */
function needsAuthHeaders(url: string): boolean {
  return url.startsWith("/api/frontmind/");
}

/**
 * Fetch image with auth headers and return blob URL
 */
async function fetchImageWithAuth(url: string): Promise<string> {
  const response = await fetch(url, {
    credentials: "include",
    headers: deliveryProjectHeaders(),
  });

  if (!response.ok) {
    throw new Error(`图片读取失败（HTTP ${response.status}）`);
  }

  const contentType = response.headers.get("content-type") || "";

  // Check if we accidentally got JSON instead of binary (metadata fallback)
  if (contentType.includes("application/json")) {
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      // If the response is file metadata with upload_url, fetch via proxy to avoid CORS
      if (data.upload_url) {
        const proxyUrl = `/api/frontmind/proxy-download?url=${encodeURIComponent(data.upload_url)}`;
        const proxyResponse = await fetch(proxyUrl, {
          credentials: "include",
          headers: deliveryProjectHeaders(),
        });
        if (!proxyResponse.ok) {
          throw new Error(`图片代理读取失败（HTTP ${proxyResponse.status}）`);
        }
        const blob = await proxyResponse.blob();
        return URL.createObjectURL(blob);
      }
    } catch (e) {
      // Not JSON or no upload_url - rethrow if it was a fetch error
      if (e instanceof Error && e.message.includes("读取失败")) throw e;
    }
    throw new Error("服务返回的不是有效图片");
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export default function ImagePreview({
  src,
  alt = "预览图片",
  className,
  showDownload = true,
}: ImagePreviewProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Fetch blob URL when component mounts or src changes (for API/proxy URLs)
  // Data URLs and blob URLs are used directly without fetching
  useEffect(() => {
    let cancelled = false;

    if (src && needsAuthHeaders(src)) {
      setLoading(true);
      setLoadError(false);
      fetchImageWithAuth(src)
        .then((url) => {
          if (!cancelled) {
            setBlobUrl(url);
            setLoading(false);
          }
        })
        .catch((err) => {
          console.error("Failed to load image:", err);
          if (!cancelled) {
            setLoadError(true);
            setLoading(false);
          }
        });
    } else {
      // For data: URLs, blob: URLs, and regular URLs - use directly
      setBlobUrl(null);
      setLoadError(false);
      setLoading(false);
    }

    // Cleanup blob URL on unmount
    return () => {
      cancelled = true;
      if (blobUrl && blobUrl.startsWith("blob:")) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [src]);

  const handleZoomIn = useCallback(() => {
    setScale((s) => Math.min(s + 0.25, 4));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((s) => Math.max(s - 0.25, 0.5));
  }, []);

  const handleRotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
  }, []);

  const handleReset = useCallback(() => {
    setScale(1);
    setRotation(0);
  }, []);

  const handleDownload = useCallback(async () => {
    try {
      let downloadUrl: string;

      if (blobUrl) {
        // Use existing blob URL
        downloadUrl = blobUrl;
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = alt || "image";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
      }

      if (needsAuthHeaders(src)) {
        // Fetch with auth for download
        const fetchedUrl = await fetchImageWithAuth(src);
        const a = document.createElement("a");
        a.href = fetchedUrl;
        a.download = alt || "image";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(fetchedUrl);
        return;
      }

      // Direct download for data URLs or regular URLs
      const response = await fetch(src);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = alt || "image";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download failed:", err);
    }
  }, [src, blobUrl, alt]);

  // Image source for the img tag: blob URL if available, otherwise original src
  const imgSrc = blobUrl || src;

  return (
    <>
      <div
        className={cn(
          "cursor-pointer overflow-hidden rounded-xl border border-border/30 shadow-sm",
          "hover:border-primary/30 transition-all duration-200 hover:shadow-md",
          className,
        )}
        onClick={() => setIsOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setIsOpen(true)}
      >
        {loading ? (
          <div className="w-full h-full flex items-center justify-center bg-muted/30 min-h-[100px]">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/50" />
          </div>
        ) : loadError ? (
          <div className="w-full h-full flex flex-col items-center justify-center bg-muted/30 min-h-[100px] p-4">
            <p className="text-xs text-muted-foreground/60">图片加载失败</p>
            {showDownload && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload();
                }}
                className="mt-2 text-xs text-primary hover:underline"
              >
                点击下载
              </button>
            )}
          </div>
        ) : (
          <img
            src={imgSrc}
            alt={alt}
            className="w-full h-auto object-cover transition-transform duration-200 hover:scale-[1.02]"
            loading="lazy"
            onError={() => setLoadError(true)}
          />
        )}
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent
          showCloseButton={false}
          className="max-w-[90vw] max-h-[90vh] p-0 bg-black/95 border-none"
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>

          {/* Controls bar */}
          <div className="absolute top-4 left-4 right-4 z-10 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={handleZoomOut}
                className="bg-black/50 hover:bg-black/70 text-white border border-white/20"
              >
                <ZoomOut className="w-4 h-4" />
              </Button>
              <span className="text-white/70 text-sm min-w-[3rem] text-center">
                {Math.round(scale * 100)}%
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleZoomIn}
                className="bg-black/50 hover:bg-black/70 text-white border border-white/20"
              >
                <ZoomIn className="w-4 h-4" />
              </Button>
              <div className="w-px h-6 bg-white/20 mx-1" />
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRotate}
                className="bg-black/50 hover:bg-black/70 text-white border border-white/20"
              >
                <RotateCw className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleReset}
                className="bg-black/50 hover:bg-black/70 text-white border border-white/20 text-xs"
              >
                重置
              </Button>
            </div>

            <div className="flex items-center gap-2">
              {showDownload && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleDownload}
                  className="bg-black/50 hover:bg-black/70 text-white border border-white/20"
                >
                  <Download className="w-4 h-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsOpen(false)}
                className="bg-black/50 hover:bg-black/70 text-white border border-white/20"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Image container */}
          <div
            className="flex items-center justify-center overflow-auto h-full w-full"
            style={{ cursor: "grab" }}
          >
            {loading ? (
              <Loader2 className="w-8 h-8 animate-spin text-white/50" />
            ) : loadError ? (
              <div className="text-white/60 text-center">
                <p>图片加载失败</p>
                <button
                  onClick={handleDownload}
                  className="mt-2 text-sm text-blue-400 hover:underline"
                >
                  点击下载
                </button>
              </div>
            ) : (
              <img
                src={imgSrc}
                alt={alt}
                className="max-w-full max-h-[85vh] object-contain transition-transform duration-200"
                style={{
                  transform: `scale(${scale}) rotate(${rotation}deg)`,
                }}
                draggable={false}
                onError={() => setLoadError(true)}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
