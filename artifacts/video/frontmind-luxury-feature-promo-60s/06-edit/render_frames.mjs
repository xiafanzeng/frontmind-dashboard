import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const productionRoot = path.resolve(import.meta.dirname, "..");
const timelinePath = path.join(import.meta.dirname, "timeline.json");
const workDir = path.join(import.meta.dirname, "work");
const frameDir = path.join(workDir, "frames");

const timeline = JSON.parse(await fs.readFile(timelinePath, "utf8"));
await fs.mkdir(frameDir, { recursive: true });

const xmlEscape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

function wrapChinese(text, maxUnits = 34) {
  const units = [...text];
  if (units.length <= maxUnits) return [text];
  const lines = [];
  let current = "";
  let count = 0;
  for (const char of units) {
    const weight = /[\x00-\xff]/.test(char) ? 0.55 : 1;
    if (count + weight > maxUnits && current) {
      lines.push(current);
      current = "";
      count = 0;
    }
    current += char;
    count += weight;
  }
  if (current) lines.push(current);
  return lines.slice(0, 2);
}

function overlaySvg(segment, index) {
  const captionLines = wrapChinese(segment.caption);
  const captionTspans = captionLines
    .map(
      (line, lineIndex) =>
        `<tspan x="96" dy="${lineIndex === 0 ? 0 : 54}">${xmlEscape(line)}</tspan>`,
    )
    .join("");
  const sequence = String(index + 1).padStart(2, "0");
  return Buffer.from(`
    <svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bottomShade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#071316" stop-opacity="0"/>
          <stop offset="44%" stop-color="#071316" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="#071316" stop-opacity="0.92"/>
        </linearGradient>
        <linearGradient id="topShade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#071316" stop-opacity="0.50"/>
          <stop offset="66%" stop-color="#071316" stop-opacity="0.08"/>
          <stop offset="100%" stop-color="#071316" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="1920" height="1080" fill="url(#bottomShade)"/>
      <rect x="0" y="0" width="1080" height="160" fill="url(#topShade)"/>
      <rect x="72" y="60" width="6" height="52" rx="3" fill="#27DFC5"/>
      <text x="98" y="82" fill="#D8FFF8" font-size="21" font-weight="650"
            font-family="PingFang SC, Hiragino Sans GB, Arial, sans-serif"
            letter-spacing="1.4">${xmlEscape(segment.chapter)}</text>
      <text x="98" y="116" fill="#FFFFFF" font-size="34" font-weight="680"
            font-family="PingFang SC, Hiragino Sans GB, Arial, sans-serif"
            letter-spacing="0.4">${xmlEscape(segment.title)}</text>
      <text x="96" y="${captionLines.length > 1 ? 930 : 958}" fill="#FFFFFF"
            font-size="43" font-weight="560"
            font-family="PingFang SC, Hiragino Sans GB, Arial, sans-serif"
            letter-spacing="0.3">${captionTspans}</text>
      <text x="96" y="1032" fill="#9BB1AE" font-size="17" font-weight="520"
            font-family="Arial, PingFang SC, sans-serif" letter-spacing="2.2">FRONTMIND · REAL PRODUCT INTERFACE</text>
      <text x="1790" y="1032" fill="#9BB1AE" font-size="17" text-anchor="end"
            font-family="Arial, sans-serif" letter-spacing="1.2">${sequence} / ${String(timeline.segments.length).padStart(2, "0")}</text>
      <rect x="72" y="1056" width="1776" height="2" fill="#FFFFFF" fill-opacity="0.15"/>
      <rect x="72" y="1056" width="${Math.round((1776 * (index + 1)) / timeline.segments.length)}" height="2" fill="#27DFC5" fill-opacity="0.95"/>
    </svg>
  `);
}

for (const [index, segment] of timeline.segments.entries()) {
  const sourcePath = path.join(productionRoot, segment.source);
  const outputPath = path.join(
    frameDir,
    `${String(index + 1).padStart(2, "0")}-${segment.id}.png`,
  );
  const overlay = overlaySvg(segment, index);
  await sharp(sourcePath)
    .resize(timeline.canvas.width, timeline.canvas.height, {
      fit: "cover",
      position: "centre",
    })
    .modulate({ brightness: 0.91, saturation: 0.9 })
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
}

const contactTileWidth = 480;
const contactTileHeight = 270;
const columns = 4;
const rows = Math.ceil(timeline.segments.length / columns);
const contactWidth = contactTileWidth * columns;
const contactHeight = contactTileHeight * rows;
const contactComposites = [];

for (const [index, segment] of timeline.segments.entries()) {
  const framePath = path.join(
    frameDir,
    `${String(index + 1).padStart(2, "0")}-${segment.id}.png`,
  );
  const thumb = await sharp(framePath)
    .resize(contactTileWidth, contactTileHeight, { fit: "cover" })
    .png()
    .toBuffer();
  contactComposites.push({
    input: thumb,
    left: (index % columns) * contactTileWidth,
    top: Math.floor(index / columns) * contactTileHeight,
  });
}

await sharp({
  create: {
    width: contactWidth,
    height: contactHeight,
    channels: 3,
    background: "#071316",
  },
})
  .composite(contactComposites)
  .jpeg({ quality: 88, chromaSubsampling: "4:4:4" })
  .toFile(path.join(workDir, "contact-sheet.jpg"));

console.log(
  `Rendered ${timeline.segments.length} frames and contact sheet to ${workDir}`,
);
