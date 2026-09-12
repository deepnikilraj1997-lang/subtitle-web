/**
 * Groq LLM translation module.
 *
 * Uses Groq's chat completions API (Llama 3.3 70B) for translation — same API key
 * as Whisper, no additional credentials needed.
 *
 * Strategy:
 *   - If language is already English: pass-through, no API call needed.
 *   - Otherwise: batch segments (80 at a time) with 6 parallel workers.
 *   - Groq returns a JSON array of translated strings, index-matched to input.
 */

import type { WhisperSegment, SubtitleSegment, AgentConfig } from "./types.js";

const BATCH_SIZE  = 80;
const CONCURRENCY = 6;

const TRANSLATION_MODEL = "llama-3.3-70b-versatile";

const ENGLISH_CODES = new Set(["en", "english"]);

const SYSTEM_PROMPT = `You are an expert subtitle translator and editor.
Your job is to translate subtitle text from any language into natural, fluent, broadcast-quality English.

Rules:
- Preserve the meaning and tone (formal/casual/emotional) of the original.
- Keep each translation concise — subtitles must be readable in the time they appear.
- Do NOT add, invent, or pad content that wasn't in the original.
- Output ONLY a valid JSON array of strings. No markdown, no explanation, no extra keys.
  Example: ["First subtitle translated.", "Second subtitle translated."]
- The array must have EXACTLY the same number of elements as the input array.`;

async function translateBatch(
  texts: string[],
  sourceLang: string,
  config: AgentConfig
): Promise<string[]> {
  const numbered = texts.map((t, i) => `${i + 1}. ${JSON.stringify(t)}`).join("\n");

  const userPrompt =
    `Translate the following ${sourceLang} subtitle segments to English.\n` +
    `Return a JSON array of ${texts.length} translated strings.\n\n` +
    `Segments:\n${numbered}`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.groqApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.translationModel || TRANSLATION_MODEL,
      max_tokens: 4096,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq translation API error ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const rawText = data.choices[0]?.message?.content?.trim() ?? "";

  const match = rawText.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new Error(`Groq returned invalid JSON. Raw response:\n${rawText.slice(0, 300)}`);
  }

  const parsed = JSON.parse(match[0]) as unknown[];

  if (!Array.isArray(parsed) || parsed.length !== texts.length) {
    throw new Error(
      `Groq returned ${parsed.length} items for ${texts.length} segments.`
    );
  }

  return parsed.map((item) => String(item).trim());
}

export async function translateToEnglish(
  segments: WhisperSegment[],
  language: string,
  config: AgentConfig,
  onProgress?: (msg: string) => void
): Promise<SubtitleSegment[]> {
  const langLower = language.toLowerCase().trim();
  const isEnglish = ENGLISH_CODES.has(langLower);

  if (isEnglish) {
    onProgress?.("Language is English — skipping translation step.");
    return segments.map((seg, i) => ({
      index: i + 1,
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
      originalText: seg.text.trim(),
      wasTranslated: false,
    }));
  }

  onProgress?.(
    `Translating ${segments.length} segments from ${language.toUpperCase()} → English ` +
    `using Groq ${config.translationModel || TRANSLATION_MODEL} in batches of ${BATCH_SIZE}…`
  );

  const result: SubtitleSegment[] = [];

  const batches: WhisperSegment[][] = [];
  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    batches.push(segments.slice(i, i + BATCH_SIZE));
  }

  const orderedResults: string[][] = new Array(batches.length);
  let nextBatch = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextBatch++;
      if (idx >= batches.length) return;
      const batch = batches[idx];
      orderedResults[idx] = await translateBatch(
        batch.map((s) => s.text),
        language,
        config
      );
      completed++;
      onProgress?.(
        `  Translated ${Math.min(completed * BATCH_SIZE, segments.length)}` +
        `/${segments.length} segments (batch ${completed}/${batches.length})`
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

  batches.forEach((batch, bi) => {
    batch.forEach((seg, si) => {
      result.push({
        index: result.length + 1,
        start: seg.start,
        end: seg.end,
        text: orderedResults[bi][si],
        originalText: seg.text.trim(),
        wasTranslated: true,
      });
    });
  });

  result.forEach((seg, i) => { seg.index = i + 1; });

  onProgress?.(`Translation complete — ${result.length} segments translated.`);
  return result;
}
