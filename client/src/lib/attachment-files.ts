import JSZip from "jszip";
import {
  inspectImageFile,
  formatFileSize,
  formatImageInspectionSummary,
  type ImageInspection,
} from "@/lib/image-inspection";

export const ZIP_REFERENCE_PROMPT =
  "附件 ZIP 中包含用户上传的原始参考图片，请解压后读取图片内容作为参考。";

export interface ZippedImageInfo {
  name: string;
  width: number;
  height: number;
  pixels: number;
  size: number;
}

export interface PreparedUploadFile {
  file: File;
  generatedFromImages?: ZippedImageInfo[];
}

export interface PreparedUploadFiles {
  files: PreparedUploadFile[];
  didZipLargeImages: boolean;
  zippedImages: ZippedImageInfo[];
}

interface OversizedImage {
  file: File;
  inspection: ImageInspection;
}

const IMAGE_FILE_EXTENSION = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/i;

export function isImageUpload(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_FILE_EXTENSION.test(file.name);
}

export async function prepareUploadFiles(
  files: File[],
): Promise<PreparedUploadFiles> {
  const preparedFiles: PreparedUploadFile[] = [];
  const oversizedImages: OversizedImage[] = [];

  for (const file of files) {
    if (isImageUpload(file)) {
      let inspection: ImageInspection | null = null;
      try {
        inspection = await inspectImageFile(file);
      } catch (err) {
        console.warn(
          `[AttachmentPrep] Failed to inspect image "${file.name}", uploading as file`,
          err,
        );
      }

      if (inspection?.isLarge) {
        oversizedImages.push({ file, inspection });
        continue;
      }
    }

    preparedFiles.push({ file });
  }

  if (oversizedImages.length > 0) {
    const zipFile = await createOriginalImagesZip(oversizedImages);
    const zippedImages = oversizedImages.map(({ file, inspection }) => ({
      name: file.name,
      width: inspection.width,
      height: inspection.height,
      pixels: inspection.pixels,
      size: file.size,
    }));

    preparedFiles.push({
      file: zipFile,
      generatedFromImages: zippedImages,
    });

    return {
      files: preparedFiles,
      didZipLargeImages: true,
      zippedImages,
    };
  }

  return {
    files: preparedFiles,
    didZipLargeImages: false,
    zippedImages: [],
  };
}

async function createOriginalImagesZip(
  images: OversizedImage[],
): Promise<File> {
  const zip = new JSZip();
  const folder = zip.folder("original-images");

  if (!folder) {
    throw new Error("创建图片 ZIP 目录失败");
  }

  const usedNames = new Set<string>();
  const readmeLines = [
    "FrontMind original image attachments",
    "",
    "These files are original, lossless user uploads. Please unzip and read them as visual references.",
    "",
    "Images:",
  ];

  images.forEach(({ file, inspection }, index) => {
    const entryName = uniqueZipEntryName(file.name, usedNames, index);
    folder.file(entryName, file, { binary: true });
    readmeLines.push(
      `- ${entryName}: ${formatImageInspectionSummary(inspection)}; original size ${formatFileSize(file.size)}`,
    );
  });

  zip.file("README.txt", readmeLines.join("\n"));

  try {
    const blob = await zip.generateAsync({
      type: "blob",
      compression: "STORE",
      mimeType: "application/zip",
    });
    return new File([blob], buildOriginalImagesZipName(), {
      type: "application/zip",
      lastModified: Date.now(),
    });
  } catch (err: any) {
    throw new Error(`图片 ZIP 打包失败：${err?.message || "未知错误"}`);
  }
}

function buildOriginalImagesZipName(now = new Date()): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `frontmind-original-images-${yyyy}${mm}${dd}.zip`;
}

function uniqueZipEntryName(
  fileName: string,
  usedNames: Set<string>,
  index: number,
): string {
  const sanitized = fileName.replace(/[\\/]/g, "_") || `image-${index + 1}`;
  if (!usedNames.has(sanitized)) {
    usedNames.add(sanitized);
    return sanitized;
  }

  const dotIndex = sanitized.lastIndexOf(".");
  const base = dotIndex > 0 ? sanitized.slice(0, dotIndex) : sanitized;
  const ext = dotIndex > 0 ? sanitized.slice(dotIndex) : "";
  let candidate = `${base}-${index + 1}${ext}`;
  let suffix = index + 1;

  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}${ext}`;
  }

  usedNames.add(candidate);
  return candidate;
}
