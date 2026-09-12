/**
 * Shared types across the subtitle agent pipeline.
 *
 * Pipeline:
 *   AudioFile → [Groq Whisper] → WhisperResponse
 *             → [Groq LLM]     → translated SubtitleSegment[]
 *             → [SRT formatter] → .srt file
 */

/** A single segment returned by Groq's Whisper API (verbose_json format) */
export interface WhisperSegment {
  id: number;
  start: number;  // seconds (float)
  end: number;    // seconds (float)
  text: string;   // original language text
}

/** Full Whisper API response */
export interface WhisperResponse {
  task: "transcribe" | "translate";
  /** ISO 639-1 language code detected, e.g. "fr", "hi", "ja", "en" */
  language: string;
  duration: number;
  text: string;
  segments: WhisperSegment[];
}

/** A subtitle card ready for SRT output */
export interface SubtitleSegment {
  index: number;   // 1-based SRT index
  start: number;   // seconds
  end: number;     // seconds
  text: string;    // final English text
  originalText: string;  // source language text
  wasTranslated: boolean;
}

/** Runtime config assembled from env vars */
export interface AgentConfig {
  groqApiKey: string;
  whisperModel: string;
  translationModel: string;
  maxLineLength: number;
  mergeGap: number;
}

/** Groq API file size limit in bytes (25 MB) */
export const GROQ_MAX_BYTES = 25 * 1024 * 1024;
