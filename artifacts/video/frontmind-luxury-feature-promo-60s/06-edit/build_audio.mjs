import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const productionRoot = path.resolve(import.meta.dirname, "..");
const timeline = JSON.parse(
  await fsp.readFile(path.join(import.meta.dirname, "timeline.json"), "utf8"),
);
const voiceDir = path.join(productionRoot, "05-audio", "voice");
const musicDir = path.join(productionRoot, "05-audio", "music");
const workDir = path.join(import.meta.dirname, "work");
await fsp.mkdir(voiceDir, { recursive: true });
await fsp.mkdir(musicDir, { recursive: true });
await fsp.mkdir(workDir, { recursive: true });

const ffmpeg = "/opt/homebrew/bin/ffmpeg";
const ffprobe = "/opt/homebrew/bin/ffprobe";
const say = "/usr/bin/say";

const durationOf = (file) =>
  Number(
    execFileSync(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file,
      ],
      { encoding: "utf8" },
    ).trim(),
  );

const voiceSegments = [];
const voiceDiagnostics = [];
for (const shot of timeline.shots) {
  const aiffPath = path.join(voiceDir, `${shot.id}.aiff`);
  const wavPath = path.join(voiceDir, `${shot.id}.wav`);
  execFileSync(say, [
    "-v",
    timeline.voice.voice,
    "-r",
    String(timeline.voice.rate),
    "-o",
    aiffPath,
    shot.narration,
  ]);
  const rawDuration = durationOf(aiffPath);
  const available = shot.duration - 0.45;
  const tempo = Math.max(1, rawDuration / available);
  if (tempo > 1.35) {
    throw new Error(
      `${shot.id} narration exceeds safe tempo: ${rawDuration.toFixed(2)}s for ${available.toFixed(2)}s`,
    );
  }
  const tempoFilter =
    tempo > 1.01 ? `atempo=${tempo.toFixed(5)},` : "";
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    aiffPath,
    "-af",
    `${tempoFilter}adelay=220|220,apad=pad_dur=${shot.duration},atrim=duration=${shot.duration},aresample=48000`,
    "-ac",
    "2",
    "-c:a",
    "pcm_s24le",
    wavPath,
  ]);
  voiceSegments.push(wavPath);
  voiceDiagnostics.push({
    id: shot.id,
    raw_duration_seconds: Number(rawDuration.toFixed(3)),
    shot_duration_seconds: shot.duration,
    applied_tempo: Number(tempo.toFixed(5)),
  });
}

const voiceConcatPath = path.join(workDir, "voice-concat.txt");
await fsp.writeFile(
  voiceConcatPath,
  voiceSegments.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n") +
    "\n",
  "utf8",
);
const voiceMaster = path.join(voiceDir, "voice-master.wav");
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
  voiceConcatPath,
  "-t",
  String(timeline.canvas.duration_seconds),
  "-c:a",
  "pcm_s24le",
  voiceMaster,
]);
await fsp.writeFile(
  path.join(voiceDir, "voice-diagnostics.json"),
  `${JSON.stringify(voiceDiagnostics, null, 2)}\n`,
  "utf8",
);

const sampleRate = 48000;
const duration = timeline.canvas.duration_seconds;
const channels = 2;
const frameCount = sampleRate * duration;
const dataSize = frameCount * channels * 2;
const wav = Buffer.allocUnsafe(44 + dataSize);

wav.write("RIFF", 0);
wav.writeUInt32LE(36 + dataSize, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(channels, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * channels * 2, 28);
wav.writeUInt16LE(channels * 2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(dataSize, 40);

const progression = [
  [146.83, 174.61, 220.0, 293.66],
  [130.81, 164.81, 196.0, 261.63],
  [116.54, 146.83, 174.61, 233.08],
  [130.81, 164.81, 220.0, 261.63],
];
const bpm = 96;
const beatSeconds = 60 / bpm;
let seed = 173;
const noise = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647 - 0.5;
};

for (let i = 0; i < frameCount; i += 1) {
  const t = i / sampleRate;
  const chordIndex = Math.floor(t / (beatSeconds * 8)) % progression.length;
  const chord = progression[chordIndex];
  const slowBreath = 0.62 + 0.18 * Math.sin((2 * Math.PI * t) / 10);
  let pad = 0;
  for (const [voiceIndex, frequency] of chord.entries()) {
    const phase = voiceIndex * 0.61;
    pad +=
      Math.sin(2 * Math.PI * frequency * t + phase) * 0.55 +
      Math.sin(2 * Math.PI * frequency * 2 * t + phase * 1.3) * 0.12;
  }
  pad = (pad / chord.length) * slowBreath;

  const beatPhase = (t % beatSeconds) / beatSeconds;
  const rootPulse =
    Math.sin(2 * Math.PI * chord[0] * 0.5 * t) *
    Math.exp(-beatPhase * 7.5) *
    0.32;
  const twoBeatPhase = (t % (beatSeconds * 2)) / (beatSeconds * 2);
  const glassPulse =
    Math.sin(2 * Math.PI * chord[2] * 2 * t) *
    Math.exp(-twoBeatPhase * 13) *
    0.035;
  const air = noise() * 0.008 * (0.45 + 0.55 * Math.sin(Math.PI * beatPhase));
  const fadeIn = Math.min(1, t / 2.2);
  const fadeOut = Math.min(1, Math.max(0, (duration - t) / 5));
  const amplitude = fadeIn * fadeOut;
  const left = (pad * 0.17 + rootPulse + glassPulse + air) * amplitude;
  const right =
    (pad * 0.17 +
      rootPulse * 0.92 +
      Math.sin(2 * Math.PI * chord[3] * 1.002 * t) * 0.015 +
      air) *
    amplitude;
  const offset = 44 + i * 4;
  wav.writeInt16LE(
    Math.max(-32767, Math.min(32767, Math.round(left * 32767))),
    offset,
  );
  wav.writeInt16LE(
    Math.max(-32767, Math.min(32767, Math.round(right * 32767))),
    offset + 2,
  );
}

const musicMaster = path.join(musicDir, "frontmind-original-ambient-96bpm.wav");
fs.writeFileSync(musicMaster, wav);
console.log(`Voice master: ${voiceMaster}`);
console.log(`Music master: ${musicMaster}`);
