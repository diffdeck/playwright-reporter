/**
 * DiffDeck Playwright reporter.
 *
 * On each test end, finds the test's video attachment, captures the per-step timeline
 * recorded via `onStepBegin`/`onStepEnd`, and uploads both to DiffDeck's recordings
 * route. Configuration comes from reporter options or environment variables.
 *
 * Add to `playwright.config.ts`:
 *
 *   reporter: [["@diffdeckai/playwright-reporter", { host: "https://diffdeck.ai" }]]
 *
 * Requires Playwright to record video, e.g. `use: { video: "on" }`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  FullConfig,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

import {
  RECORDING_METADATA_SCHEMA_VERSION,
  type DiffDeckReporterMode,
  type DiffDeckReporterOptions,
  type RecordingMetadata,
  type RecordingSidecar,
  type RecordingStep,
} from "./types";
import { postRecording, type RecordingUpload } from "./upload";

const PACKAGE_NAME = "@diffdeckai/playwright-reporter";
// Read from package.json at runtime so it never drifts (surfaced in the uploaded
// metadata as `reporterVersion`). Resolves from dist/ (../package.json) and from
// src/ under tsx during tests; falls back to "0.0.0" if it can't be read.
const PACKAGE_VERSION: string = (() => {
  try {
    return require("../package.json").version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const DEFAULT_HOST = "https://diffdeck.ai";

const ACCEPTED_VIDEO_TYPES = new Set(["video/webm", "video/mp4"]);

function firstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = process.env[key];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

/** Per-test accumulator of captured steps. Keyed by `TestResult` identity. */
type StepBuffer = RecordingStep[];

export default class DiffDeckReporter implements Reporter {
  private readonly options: DiffDeckReporterOptions;
  private readonly host: string;
  private readonly token: string | undefined;
  private readonly branch: string | undefined;
  private readonly commitSha: string | undefined;
  private readonly quiet: boolean;
  private readonly mode: DiffDeckReporterMode;
  private rootDir = process.cwd();

  /** Steps collected per (test, result) run. */
  private readonly steps = new WeakMap<TestResult, StepBuffer>();

  /** Once the repo's recordings add-on is gated (402), stop trying. */
  private gated = false;
  private uploaded = 0;
  private written = 0;
  private skipped = 0;
  private failures = 0;

  constructor(options: DiffDeckReporterOptions = {}) {
    this.options = options;
    this.mode = options.mode ?? (firstEnv("DIFFDECK_MODE") === "write" ? "write" : "upload");
    this.host = options.host ?? firstEnv("DIFFDECK_HOST") ?? DEFAULT_HOST;
    this.token = options.token ?? firstEnv("DIFFDECK_TOKEN");
    this.branch =
      options.branch ??
      firstEnv("DIFFDECK_BRANCH", "GITHUB_HEAD_REF", "GITHUB_REF_NAME", "CI_COMMIT_REF_NAME", "GIT_BRANCH");
    this.commitSha =
      options.commitSha ??
      firstEnv("DIFFDECK_COMMIT", "GITHUB_SHA", "CI_COMMIT_SHA", "GIT_COMMIT");
    this.quiet = options.quiet ?? false;
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig): void {
    this.rootDir = config.rootDir || process.cwd();
    if (this.mode === "upload" && !this.token) {
      this.warn(
        `no token configured (set DIFFDECK_TOKEN or the reporter's "token" option) — recordings will not be uploaded`
      );
    }
  }

  onStepBegin(_test: TestCase, result: TestResult, _step: TestStep): void {
    if (!this.steps.has(result)) this.steps.set(result, []);
  }

  onStepEnd(_test: TestCase, result: TestResult, step: TestStep): void {
    const categories = this.options.stepCategories;
    if (categories && !categories.includes(step.category)) return;

    const buffer = this.steps.get(result) ?? [];
    const testStart = result.startTime instanceof Date ? result.startTime.getTime() : Date.now();
    const stepStart = step.startTime instanceof Date ? step.startTime.getTime() : testStart;
    const startMs = Math.max(0, stepStart - testStart);
    const duration = Number.isFinite(step.duration) && step.duration >= 0 ? step.duration : 0;

    const record: RecordingStep = {
      title: step.title,
      category: step.category,
      startMs,
      endMs: startMs + duration,
      durationMs: duration,
      depth: stepDepth(step),
    };
    if (step.error?.message) record.error = step.error.message;
    if (step.location) record.location = `${step.location.file}:${step.location.line}:${step.location.column}`;

    buffer.push(record);
    this.steps.set(result, buffer);
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    const buffer = this.steps.get(result) ?? [];
    this.steps.delete(result);

    if (this.gated || (this.mode === "upload" && !this.token)) {
      this.skipped++;
      return;
    }

    const video = result.attachments.find(
      (a) => a.name === "video" && (a.path || a.body)
    );
    if (!video) {
      // Tests without recorded video are silently skipped (e.g. video disabled or
      // the test was skipped before a context was created).
      this.skipped++;
      return;
    }

    const metadata: RecordingMetadata = {
      schemaVersion: RECORDING_METADATA_SCHEMA_VERSION,
      reporter: PACKAGE_NAME,
      reporterVersion: PACKAGE_VERSION,
      recordingStartTime: (result.startTime instanceof Date
        ? result.startTime
        : new Date()
      ).toISOString(),
      testDurationMs: Number.isFinite(result.duration) ? result.duration : 0,
      // Steps end inner-first; present them ordered by start time so the player can
      // render a natural top-to-bottom timeline (ties keep insertion order).
      steps: buffer
        .map((step, index) => ({ step, index }))
        .sort((a, b) => a.step.startMs - b.step.startMs || a.index - b.index)
        .map(({ step }) => step),
    };

    // Write mode: drop a `<video>.json` sidecar next to the video and let a later
    // step (the diffdeck CLI / Action) upload it. Requires an on-disk video path.
    if (this.mode === "write") {
      if (!video.path) {
        this.warn(`no on-disk video path for "${test.title}" — cannot write a sidecar (record video to disk, not inline)`);
        this.skipped++;
        return;
      }
      const sidecar: RecordingSidecar = {
        test: test.title,
        file: this.relativeFile(test),
        testId: test.id,
        status: result.status,
        durationMs: result.duration,
        retries: result.retry,
        branch: this.branch,
        commit: this.commitSha,
        metadata,
      };
      try {
        await writeFile(`${video.path}.json`, JSON.stringify(sidecar, null, 2));
        this.written++;
      } catch (e: any) {
        this.warn(`could not write sidecar for "${test.title}": ${e?.message ?? e}`);
        this.failures++;
      }
      return;
    }

    // Upload mode: read the video bytes and POST to DiffDeck.
    let bytes: Buffer;
    try {
      bytes = video.body ? Buffer.from(video.body) : await readFile(video.path!);
    } catch (e: any) {
      this.warn(`could not read video for "${test.title}": ${e?.message ?? e}`);
      this.failures++;
      return;
    }
    if (bytes.byteLength === 0) {
      this.skipped++;
      return;
    }

    const videoType = ACCEPTED_VIDEO_TYPES.has(video.contentType)
      ? video.contentType
      : "video/webm";

    const upload: RecordingUpload = {
      video: bytes,
      videoType,
      filename: basename(video.path || `${test.id}.webm`),
      testTitle: test.title,
      testFile: this.relativeFile(test),
      testId: test.id,
      status: result.status,
      durationMs: result.duration,
      retries: result.retry,
      branch: this.branch,
      commitSha: this.commitSha,
      metadata,
    };

    const outcome = await postRecording(this.host, this.token!, upload);
    if (outcome.ok) {
      this.uploaded++;
      return;
    }
    if (outcome.gated) {
      // 402: recordings add-on not enabled for this repo. Warn once and stop.
      this.gated = true;
      this.skipped++;
      this.warn(`recordings are not enabled for this DiffDeck repository — skipping further uploads`);
      return;
    }
    this.failures++;
    this.warn(`upload failed for "${test.title}" (HTTP ${outcome.status}): ${outcome.message}`);
  }

  async onEnd(): Promise<void> {
    if (this.quiet) return;
    if (this.mode === "upload" && !this.token) return;
    const parts = [this.mode === "write" ? `${this.written} written` : `${this.uploaded} uploaded`];
    if (this.skipped) parts.push(`${this.skipped} skipped`);
    if (this.failures) parts.push(`${this.failures} failed`);
    this.log(`recordings: ${parts.join(", ")}`);
  }

  private relativeFile(test: TestCase): string | undefined {
    const file = test.location?.file;
    if (!file) return undefined;
    if (this.rootDir && file.startsWith(this.rootDir)) {
      return file.slice(this.rootDir.length).replace(/^[\\/]+/, "");
    }
    return file;
  }

  private log(message: string): void {
    if (!this.quiet) console.log(`[diffdeck] ${message}`);
  }

  private warn(message: string): void {
    if (!this.quiet) console.warn(`[diffdeck] ${message}`);
  }
}

/** Count the parent chain of a step to derive its nesting depth (0 = top level). */
function stepDepth(step: TestStep): number {
  let depth = 0;
  let parent = step.parent;
  while (parent) {
    depth++;
    parent = parent.parent;
  }
  return depth;
}
