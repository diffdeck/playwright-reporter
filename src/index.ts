/**
 * @diffdeck/playwright-reporter — entry point.
 *
 * The default export is the Playwright `Reporter` class; reference it from
 * `playwright.config.ts` by package name. Types describing the uploaded step-timeline
 * `metadata` document are re-exported for consumers (e.g. the DiffDeck player).
 */
export { default } from "./reporter";
export { default as DiffDeckReporter } from "./reporter";

export type {
  DiffDeckReporterOptions,
  RecordingMetadata,
  RecordingStep,
} from "./types";
export { RECORDING_METADATA_SCHEMA_VERSION } from "./types";

export type { RecordingUpload, UploadOutcome } from "./upload";
export { buildRecordingForm, postRecording, RECORDINGS_PATH } from "./upload";
