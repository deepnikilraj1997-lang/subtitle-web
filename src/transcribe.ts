/**
 * Groq Whisper transcription module.
 *
 * Sends an audio file to Groq's cloud Whisper endpoint and returns
 * timestamped segments + the detected language code.
 *
 * No GPU on your machine — Groq runs everything in their cloud.
 * Free tier: generous, no credit card needed for sign-up.
 *
 * Endpoint: POST https://api.groq.com/openai/v1/audio/transcriptions
 * Docs:     https://console.groq.com/docs/speech-text
 */

import fs from "fs";
import path from "path";
import type { WhisperResponse, AgentConfig } from "./types.js";
import { GROQ_MAX_BYTES } from "./types.js";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/** Check audio file size and warn if it needs splitting */
export function checkFileSize(filePath: string): { bytes: number; needsSplit: boolean } {
  const bytes = fs.statSync(filePath).size;
  return { bytes, needsSplit: bytes > GROQ_MAX_BYTES };
}

/**
 * Transcribe an audio file using Groq Whisper.
 * Returns a WhisperResponse with full segment timestamps and language detection.
 *
 * @param filePath  Absolute path to the audio file (MP3, WAV, M4A, FLAC, OGG, WEBM)
 * @param config    Agent config (needs groqApiKey + whisperModel)
 * @param onProgress  Optional callback for status updates
 */
export async function transcribeAudio(
  filePath: string,
  config: AgentConfig,
  onProgress?: (msg: string) => void
): Promise<WhisperResponse> {
  const { bytes, needsSplit } = checkFileSize(filePath);

  if (needsSplit) {
    throw new Error(
      `Audio file is ${(bytes / 1024 / 1024).toFixed(1)} MB, which exceeds Groq's 25 MB limit.\n` +
      "Split it first with ffmpeg:\n" +
      "  ffmpeg -i input.mp3 -f segment -segment_time 600 -c copy chunk_%03d.mp3\n" +
      "Then run the agent on each chunk and concatenate the .srt files."
    );
  }

  onProgress?.(`Reading audio file (${(bytes / 1024 / 1024).toFixed(1)} MB)…`);

  const form = new FormData();

  const audioBuffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().slice(1) || "mp3";
  const mimeMap: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    flac: "audio/flac",
    ogg: "audio/ogg",
    webm: "audio/webm",
    aac: "audio/aac",
  };
  const mime = mimeMap[ext] ?? "audio/mpeg";
  const blob = new Blob([audioBuffer], { type: mime });

  form.append("file", blob, path.basename(filePath));
  form.append("model", config.whisperModel);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("temperature", "0");

  onProgress?.(`Sending to Groq Whisper (${config.whisperModel})…`);

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.groqApiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq Whisper API error ${response.status}: ${errText}`);
  }

  const result = (await response.json()) as WhisperResponse;

  onProgress?.(
    `Transcription complete — detected language: ${result.language.toUpperCase()}, ` +
    `${result.segments.length} segments, ${result.duration.toFixed(1)}s duration`
  );

  return result;
}
