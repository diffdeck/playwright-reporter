/**
 * Public types for @diffdeckai/playwright-reporter.
 *
 * The reporter uploads each Playwright test's video recording to DiffDeck and,
 * alongside it, a JSON `metadata` document describing the per-step timeline. That
 * document is the contract the DiffDeck player consumes to overlay step markers on
 * the video timeline — its shape is `RecordingMetadata` below.
 */

/** Bumped whenever the `RecordingMetadata` shape changes in a breaking way. */
export const RECORDING_METADATA_SCHEMA_VERSION = 1;

/**
 * One captured Playwright test step, with timing expressed in milliseconds
 * **relative to the start of the recording** (which equals the test's start time —
 * see `RecordingMetadata.recordingStartTime`). The DiffDeck player positions each
 * step on the video timeline using `startMs`/`endMs`.
 */
export interface RecordingStep {
  /** Human-readable step label, e.g. "Navigate to /login" or "expect(locator).toBeVisible()". */
  title: string;
  /**
   * Playwright step category — one of `test.step`, `expect`, `pw:api`, `hook`,
   * `fixture`, etc. Lets the player colour/group steps by kind.
   */
  category: string;
  /** Start offset in ms from the recording start (>= 0). */
  startMs: number;
  /** End offset in ms from the recording start (>= startMs). */
  endMs: number;
  /** Convenience: `endMs - startMs`. */
  durationMs: number;
  /** Nesting depth (0 = top-level step; children of a step are depth+1). */
  depth: number;
  /** Error message if the step failed; omitted otherwise. */
  error?: string;
  /** Source location `file:line:column` if Playwright provided one; omitted otherwise. */
  location?: string;
}

/**
 * The full `metadata` JSON document uploaded with each recording. Serialized to the
 * multipart `metadata` field as a JSON string.
 */
export interface RecordingMetadata {
  /** Schema version of this document (see `RECORDING_METADATA_SCHEMA_VERSION`). */
  schemaVersion: number;
  /** Reporter that produced the document, e.g. "@diffdeckai/playwright-reporter". */
  reporter: string;
  /** Reporter package version. */
  reporterVersion: string;
  /**
   * ISO-8601 timestamp marking the zero point of the step timeline (the test's
   * `startTime`). All step `startMs`/`endMs` are offsets from this instant, which is
   * also the best available alignment to the start of the video recording.
   */
  recordingStartTime: string;
  /** Total test duration in ms (Playwright `result.duration`). */
  testDurationMs: number;
  /** The captured steps, in begin order. */
  steps: RecordingStep[];
}

/**
 * A metadata sidecar written next to a recording's video file in `"write"` mode
 * (`<video>.json`). It carries everything the DiffDeck upload path needs so the
 * uploader (the `diffdeck` CLI / GitHub Action) doesn't have to derive anything
 * from file paths. Keys mirror the CLI's `upload-recording` flags.
 */
export interface RecordingSidecar {
  /** Test title (→ `--test`). */
  test: string;
  /** Repo-relative test file path (→ `--file`), if known. */
  file?: string;
  /** Stable Playwright test id (→ `--test-id`). */
  testId: string;
  /** Test status, e.g. `passed`/`failed`/`skipped` (→ `--status`). */
  status: string;
  /** Test duration in ms (→ `--duration`). */
  durationMs: number;
  /** Retry count (→ `--retries`). */
  retries: number;
  /** Git branch, if resolved (→ `--branch`). */
  branch?: string;
  /** Git commit SHA, if resolved (→ `--commit`). */
  commit?: string;
  /** The rich step-timeline document (→ `--metadata`, serialized to JSON). */
  metadata: RecordingMetadata;
}

/** How the reporter emits recordings. */
export type DiffDeckReporterMode =
  /** Upload each recording to DiffDeck as the test run proceeds (default). */
  | "upload"
  /** Write a `<video>.json` sidecar next to each video; a later step uploads. */
  | "write";

/** Options accepted by the reporter in `playwright.config.ts`. */
export interface DiffDeckReporterOptions {
  /**
   * How to emit recordings. `"upload"` (default) posts each to DiffDeck during the
   * run; `"write"` writes a `<video>.json` metadata sidecar next to each video so a
   * later step (the `diffdeck` CLI / GitHub Action) uploads them. Falls back to the
   * `DIFFDECK_MODE` env var. In `"write"` mode no token is needed.
   */
  mode?: DiffDeckReporterMode;
  /**
   * DiffDeck host base URL (no trailing slash needed). Recordings are POSTed to
   * `<host>/api/products/ui-review/recordings`. Falls back to the `DIFFDECK_HOST`
   * env var, then to `https://diffdeck.ai`.
   */
  host?: string;
  /**
   * Per-repo project token sent as the `X-UI-Review-Token` header. Falls back to the
   * `DIFFDECK_TOKEN` env var. If neither is set, uploads are skipped (with a warning).
   */
  token?: string;
  /** Git branch to tag recordings with. Falls back to common CI env vars (see README). */
  branch?: string;
  /** Git commit SHA to tag recordings with. Falls back to common CI env vars (see README). */
  commitSha?: string;
  /**
   * If set, only steps whose `category` is in this list are captured. By default all
   * steps are captured. Example: `["test.step", "expect"]` for a high-level timeline.
   */
  stepCategories?: string[];
  /** Silence the reporter's console output. Default `false`. */
  quiet?: boolean;
}
