import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

const productionRoot = path.resolve(import.meta.dirname, "..");
const timeline = JSON.parse(
  await fsp.readFile(path.join(import.meta.dirname, "timeline.json"), "utf8"),
);
const workDir = path.join(import.meta.dirname, "work");
const frameDir = path.join(workDir, "frames");
const clipDir = path.join(workDir, "clips");
const deliveryDir = path.join(productionRoot, "08-delivery");
const audioDir = path.join(productionRoot, "05-audio");
await fsp.mkdir(clipDir, { recursive: true });
await fsp.mkdir(deliveryDir, { recursive: true });

const ffmpeg = "/opt/homebrew/bin/ffmpeg";
const ffprobe = "/opt/homebrew/bin/ffprobe";

const framePathFor = (segment, index) =>
  path.join(
    frameDir,
    `${String(index + 1).padStart(2, "0")}-${segment.id}.png`,
  );

const clipPaths = [];
for (const [index, segment] of timeline.segments.entries()) {
  const framePath = framePathFor(segment, index);
  const clipPath = path.join(
    clipDir,
    `${String(index + 1).padStart(2, "0")}-${segment.id}.mp4`,
  );
  const panX =
    segment.motion === "left"
      ? "(iw-iw/zoom)*(1-on/(duration*30))"
      : segment.motion === "right"
        ? "(iw-iw/zoom)*(on/(duration*30))"
        : "(iw-iw/zoom)/2";
  const panY = "(ih-ih/zoom)/2";
  const filter = [
    "scale=2048:1152:force_original_aspect_ratio=increase",
    "crop=2048:1152",
    `zoompan=z='min(zoom+0.00012,1.026)':x='${panX.replaceAll("duration", String(segment.duration))}':y='${panY}':d=1:s=1920x1080:fps=30`,
    "format=yuv420p",
  ].join(",");
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(timeline.canvas.fps),
    "-i",
    framePath,
    "-vf",
    filter,
    "-t",
    String(segment.duration),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "17",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(timeline.canvas.fps),
    clipPath,
  ]);
  clipPaths.push(clipPath);
}

const concatPath = path.join(workDir, "video-concat.txt");
await fsp.writeFile(
  concatPath,
  clipPaths.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n") +
    "\n",
  "utf8",
);
const pictureMaster = path.join(workDir, "picture-master.mp4");
execFileSync(ffmpeg, [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  concatPath,
  "-t",
  String(timeline.canvas.duration_seconds),
  "-c",
  "copy",
  pictureMaster,
]);

const voiceMaster = path.join(audioDir, "voice", "voice-master.wav");
const musicMaster = path.join(
  audioDir,
  "music",
  "frontmind-original-ambient-96bpm.wav",
);
const reviewMaster = path.join(workDir, "frontmind-review-v1.mp4");
const finalMaster = path.join(deliveryDir, "frontmind-luxury-promo-2min-16x9.mp4");
const audioFilter = [
  "[1:a]volume=1.35,highpass=f=70,lowpass=f=12500[voice]",
  "[2:a]volume=0.20,highpass=f=45,lowpass=f=10500[music]",
  "[music][voice]sidechaincompress=threshold=0.045:ratio=6:attack=35:release=550[ducked]",
  "[voice][ducked]amix=inputs=2:duration=longest:dropout_transition=0,",
  "loudnorm=I=-16:TP=-1.5:LRA=8[aout]",
].join("");

for (const output of [reviewMaster, finalMaster]) {
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    pictureMaster,
    "-i",
    voiceMaster,
    "-i",
    musicMaster,
    "-filter_complex",
    audioFilter,
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-t",
    String(timeline.canvas.duration_seconds),
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    output,
  ]);
}

const srtTime = (seconds) => {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
};
const vttTime = (seconds) => srtTime(seconds).replace(",", ".");
const srt = timeline.shots
  .map(
    (shot, index) =>
      `${index + 1}\n${srtTime(shot.start + 0.18)} --> ${srtTime(shot.start + shot.duration - 0.2)}\n${shot.narration}\n`,
  )
  .join("\n");
const vtt = `WEBVTT\n\n${timeline.shots
  .map(
    (shot) =>
      `${vttTime(shot.start + 0.18)} --> ${vttTime(shot.start + shot.duration - 0.2)}\n${shot.narration}\n`,
  )
  .join("\n")}`;
const transcript = timeline.shots
  .map((shot) => `${srtTime(shot.start).slice(3, 8)}  ${shot.narration}`)
  .join("\n");
await fsp.writeFile(
  path.join(deliveryDir, "frontmind-zh-CN.srt"),
  `${srt}\n`,
  "utf8",
);
await fsp.writeFile(
  path.join(deliveryDir, "frontmind-zh-CN.vtt"),
  `${vtt}\n`,
  "utf8",
);
await fsp.writeFile(
  path.join(deliveryDir, "frontmind-transcript-zh-CN.txt"),
  `${transcript}\n`,
  "utf8",
);

const probe = JSON.parse(
  execFileSync(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size,bit_rate:stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels",
      "-of",
      "json",
      finalMaster,
    ],
    { encoding: "utf8" },
  ),
);
await fsp.writeFile(
  path.join(workDir, "final-ffprobe.json"),
  `${JSON.stringify(probe, null, 2)}\n`,
  "utf8",
);
console.log(`Review master: ${reviewMaster}`);
console.log(`Final master: ${finalMaster}`);
