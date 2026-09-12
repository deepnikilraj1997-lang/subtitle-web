/**
 * SRT formatter — converts SubtitleSegments to standard .srt file content.
 */

import type { SubtitleSegment, AgentConfig } from "./types.js";

export function secondsToSrtTime(secs: number): string {
  const totalMs = Math.round(secs * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");

  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

export function wrapText(text: string, maxLen: number): string {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxLen && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  return lines.slice(0, 2).join("\n");
}

export function mergeSegments(
  segments: SubtitleSegment[],
  mergeGap: number
): SubtitleSegment[] {
  if (segments.length === 0) return [];

  const merged: SubtitleSegment[] = [];
  let current = { ...segments[0] };

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    const gap = next.start - current.end;

    if (gap <= mergeGap && current.wasTranslated === next.wasTranslated) {
      current = {
        ...current,
        end: next.end,
        text: `${current.text} ${next.text}`,
        originalText: `${current.originalText} ${next.originalText}`,
      };
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  merged.forEach((seg, i) => { seg.index = i + 1; });
  return merged;
}

export function renderSrt(segments: SubtitleSegment[], config: AgentConfig): string {
  const blocks = segments.map((seg) => {
    const start = secondsToSrtTime(seg.start);
    const end = secondsToSrtTime(seg.end);
    const text = wrapText(seg.text, config.maxLineLength);
    return `${seg.index}\n${start} --> ${end}\n${text}`;
  });

  return blocks.join("\n\n") + "\n";
}

export function buildStats(
  segments: SubtitleSegment[],
  language: string,
  durationSec: number
): string {
  const translated = segments.filter((s) => s.wasTranslated).length;
  const pct = segments.length ? Math.round((translated / segments.length) * 100) : 0;

  return (
    `${segments.length} subtitle cards | ` +
    `source: ${language.toUpperCase()} | ` +
    `translated: ${translated}/${segments.length} (${pct}%) | ` +
    `duration: ${Math.floor(durationSec / 60)}m ${Math.round(durationSec % 60)}s`
  );
}
