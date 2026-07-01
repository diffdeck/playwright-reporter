/**
 * Builds the multipart payload for a recording and POSTs it to DiffDeck. Kept
 * separate from the reporter so it can be unit-tested against a mocked `fetch`.
 *
 * The route accepts `multipart/form-data` with a `video` blob plus test-identity and
 * timing fields, authenticated by the per-repo project token in the
 * `X-UI-Review-Token` header. See the DiffDeck `ui-review` recordings route for the
 * authoritative field list.
 */
import type { RecordingMetadata } from "./types";

export interface RecordingUpload {
  /** The recorded video bytes. */
  video: Uint8Array | Buffer;
  /** MIME type of the video, e.g. "video/webm". */
  videoType: string;
  /** Suggested filename for the multipart part. */
  filename: string;
  testTitle: string;
  testFile?: string;
  testId?: string;
  /** Playwright test status: passed | failed | timedOut | skipped | interrupted. */
  status?: string;
  durationMs?: number;
  retries?: number;
  branch?: string;
  commitSha?: string;
  metadata: RecordingMetadata;
}

export const RECORDINGS_PATH = "/api/products/ui-review/recordings";

export type UploadOutcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; gated: boolean; message: string };

/** Assemble the `FormData` sent to the recordings route from an upload descriptor. */
export function buildRecordingForm(upload: RecordingUpload): FormData {
  const form = new FormData();
  // The route reads `video` as a Blob; wrap the bytes with the right content type.
  const blob = new Blob([toArrayBuffer(upload.video)], { type: upload.videoType });
  form.set("video", blob, upload.filename);
  form.set("videoType", upload.videoType);
  form.set("testTitle", upload.testTitle);
  if (upload.testFile) form.set("testFile", upload.testFile);
  if (upload.testId) form.set("testId", upload.testId);
  if (upload.status) form.set("status", upload.status);
  if (upload.durationMs != null) form.set("durationMs", String(Math.round(upload.durationMs)));
  if (upload.retries != null) form.set("retries", String(Math.round(upload.retries)));
  if (upload.branch) form.set("branch", upload.branch);
  if (upload.commitSha) form.set("commitSha", upload.commitSha);
  form.set("metadata", JSON.stringify(upload.metadata));
  return form;
}

/** POST a recording to `<host><RECORDINGS_PATH>`. Never throws — returns an outcome. */
export async function postRecording(
  host: string,
  token: string,
  upload: RecordingUpload,
  fetchImpl: typeof fetch = fetch
): Promise<UploadOutcome> {
  const url = `${host.replace(/\/+$/, "")}${RECORDINGS_PATH}`;
  const form = buildRecordingForm(upload);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "X-UI-Review-Token": token },
      body: form,
    });
  } catch (e: any) {
    return { ok: false, status: 0, gated: false, message: `network error: ${e?.message ?? e}` };
  }

  if (res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* body is optional */
    }
    return { ok: true, status: res.status, body };
  }

  // 402 = recordings add-on not enabled for this repo. Surface it as a "gated" outcome
  // so the reporter can warn once and stop trying, rather than failing the run.
  const message = await safeErrorText(res);
  return { ok: false, status: res.status, gated: res.status === 402, message };
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    const data: any = await res.clone().json();
    if (data && typeof data.error === "string") return data.error;
    if (data && typeof data.message === "string") return data.message;
  } catch {
    /* fall through to text */
  }
  try {
    return (await res.text()) || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function toArrayBuffer(data: Uint8Array | Buffer): ArrayBuffer {
  // Copy into a fresh ArrayBuffer so Blob never sees a SharedArrayBuffer / pooled view.
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(data);
  return out;
}
