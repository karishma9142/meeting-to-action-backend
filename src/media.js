import { spawn } from "child_process";
import fs from "fs";

const WHISPER_LIMIT = 25 * 1024 * 1024; // Groq free-tier file limit

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(e.code === "ENOENT" ? new Error("FFMPEG_MISSING") : e));
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("ffmpeg could not read this file (no audio track?): " + err.slice(-200)))
    );
  });
}

/**
 * Accepts any audio or video file. Strips video, converts to mono 16kHz 32kbps mp3
 * (~14MB per hour), so long meetings fit in the Whisper size limit.
 * Returns { path, temp } - delete `path` afterwards if temp is true.
 */
export async function prepareAudio(inputPath) {
  const out = `${inputPath}-audio.mp3`;
  try {
    await ffmpeg(["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", out]);
    if (fs.statSync(out).size > WHISPER_LIMIT) {
      fs.unlink(out, () => {});
      throw new Error("Recording is too long for one request (over ~100 minutes). Please split it.");
    }
    return { path: out, temp: true };
  } catch (e) {
    if (e.message === "FFMPEG_MISSING") {
      // No ffmpeg: small audio/mp4/webm files can still go straight to Whisper
      if (fs.statSync(inputPath).size <= WHISPER_LIMIT) return { path: inputPath, temp: false };
      throw new Error("This file is over 25MB. Install ffmpeg on the server so it can be compressed.");
    }
    throw e;
  }
}
