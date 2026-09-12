/**
 * Subtitle Web — Express Server
 *
 * Routes:
 *   GET  /              → serve frontend HTML
 *   GET  /health        → health check
 *   POST /api/subtitle  → upload audio, get back { jobId }
 *   GET  /api/events/:jobId → SSE stream of progress events
 *   GET  /api/result/:jobId → { srt, language, stats, segments }
 */

import express, { Request, Response } from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

import { transcribeAudio } from "./transcribe.js";
import { translateToEnglish } from "./translate.js";
import { mergeSegments, renderSrt, buildStats } from "./srt.js";
import type { AgentConfig, SubtitleSegment } from "./types.js";

dotenv.config();

const PORT = Number(process.env["PORT"] ?? 3000);
const MAX_MB = Number(process.env["MAX_UPLOAD_MB"] ?? 25);

function makeConfig(): AgentConfig {
  return {
    groqApiKey: process.env["GROQ_API_KEY"] ?? "",
    whisperModel: process.env["WHISPER_MODEL"] ?? "whisper-large-v3-turbo",
    translationModel: process.env["TRANSLATION_MODEL"] ?? "llama-3.3-70b-versatile",
    maxLineLength: Number(process.env["MAX_LINE_LENGTH"] ?? 42),
    mergeGap: Number(process.env["MERGE_GAP"] ?? 0.3),
  };
}

type JobStatus = "pending" | "processing" | "done" | "error";

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

interface Job {
  id: string;
  status: JobStatus;
  events: SseEvent[];
  result?: {
    srt: string;
    language: string;
    stats: string;
    segments: SubtitleSegment[];
  };
  error?: string;
  listeners: Response[];
  createdAt: number;
}

const jobs = new Map<string, Job>();

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 30 * 60 * 1000) jobs.delete(id);
  }
}, 5 * 60 * 1000);

function pushEvent(job: Job, event: SseEvent): void {
  job.events.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.listeners) {
    try { res.write(payload); } catch { /* client disconnected */ }
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(mp3|wav|m4a|flac|ogg|webm|aac)$/i.test(file.originalname);
    cb(null, ok);
  },
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.post("/api/subtitle", upload.single("audio"), (req: Request, res: Response): void => {
  const config = makeConfig();

  if (!config.groqApiKey) {
    res.status(500).json({ error: "Server is missing GROQ_API_KEY. Check environment variables." });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "No audio file uploaded." });
    return;
  }

  const jobId = uuidv4();
  const job: Job = {
    id: jobId,
    status: "pending",
    events: [],
    listeners: [],
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);

  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "subtitle-"));
  const ext = path.extname(req.file.originalname) || ".mp3";
  const tmpPath = path.join(tmpDir, `audio${ext}`);
  fs.writeFileSync(tmpPath, req.file.buffer);

  processJob(job, tmpPath, req.file.originalname, config).finally(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  res.json({ jobId });
});

app.get("/api/events/:jobId", (req: Request, res: Response): void => {
  const job = jobs.get(req.params["jobId"] ?? "");
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  for (const event of job.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  if (job.status === "done" || job.status === "error") {
    res.end();
    return;
  }

  job.listeners.push(res);

  req.on("close", () => {
    const idx = job.listeners.indexOf(res);
    if (idx !== -1) job.listeners.splice(idx, 1);
  });
});

app.get("/api/result/:jobId", (req: Request, res: Response): void => {
  const job = jobs.get(req.params["jobId"] ?? "");
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  if (job.status !== "done") { res.status(202).json({ status: job.status }); return; }
  res.json(job.result);
});

async function processJob(
  job: Job,
  audioPath: string,
  originalName: string,
  config: AgentConfig
): Promise<void> {
  job.status = "processing";

  try {
    pushEvent(job, { type: "step", step: "transcribing", message: "Sending to Groq Whisper…" });

    const whisper = await transcribeAudio(audioPath, config, (msg) => {
      pushEvent(job, { type: "progress", step: "transcribing", message: msg });
    });

    pushEvent(job, {
      type: "language",
      language: whisper.language,
      duration: whisper.duration,
      segmentCount: whisper.segments.length,
    });

    pushEvent(job, { type: "step", step: "translating", message: "Translating with Groq LLM…" });

    const subtitleSegments = await translateToEnglish(
      whisper.segments,
      whisper.language,
      config,
      (msg) => {
        pushEvent(job, { type: "progress", step: "translating", message: msg });
      }
    );

    pushEvent(job, { type: "step", step: "formatting", message: "Formatting SRT…" });

    const merged = mergeSegments(subtitleSegments, config.mergeGap);
    const srt = renderSrt(merged, config);
    const stats = buildStats(merged, whisper.language, whisper.duration);
    const outputName = originalName.replace(/\.[^.]+$/, "") + "_en.srt";

    job.result = {
      srt,
      language: whisper.language,
      stats,
      segments: merged,
    };
    job.status = "done";

    pushEvent(job, {
      type: "done",
      srt,
      language: whisper.language,
      stats,
      outputName,
      segments: merged.slice(0, 50),
    });

  } catch (err) {
    job.status = "error";
    job.error = (err as Error).message;
    pushEvent(job, { type: "error", message: (err as Error).message });
  } finally {
    for (const res of job.listeners) {
      try { res.end(); } catch { /* ignore */ }
    }
    job.listeners = [];
  }
}

app.listen(PORT, () => {
  console.log(`\n  🎙️  Subtitle Web  ready at http://localhost:${PORT}\n`);
  if (!process.env["GROQ_API_KEY"]) console.warn("  ⚠  GROQ_API_KEY not set");
});
