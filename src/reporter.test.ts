/**
 * Unit tests: drive the reporter against fabricated Playwright test/step events with a
 * mocked `fetch`, and assert the multipart payload + the step-timeline metadata shape.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import DiffDeckReporter from "./reporter";
import { buildRecordingForm, type RecordingUpload } from "./upload";
import type { RecordingMetadata } from "./types";

const TEST_START = new Date("2026-06-30T12:00:00.000Z");

function fakeConfig(rootDir = "/repo"): any {
  return { rootDir };
}

function fakeTest(): any {
  return {
    id: "test-abc",
    title: "logs in successfully",
    location: { file: "/repo/e2e/login.spec.ts", line: 10, column: 3 },
  };
}

function fakeResult(): any {
  return {
    status: "passed",
    duration: 1500,
    retry: 0,
    startTime: TEST_START,
    attachments: [
      {
        name: "video",
        contentType: "video/webm",
        body: Buffer.from("FAKEVIDEOBYTES"),
      },
    ],
  };
}

function step(opts: {
  title: string;
  category: string;
  offsetMs: number;
  duration: number;
  parent?: any;
  error?: string;
}): any {
  return {
    title: opts.title,
    category: opts.category,
    startTime: new Date(TEST_START.getTime() + opts.offsetMs),
    duration: opts.duration,
    parent: opts.parent,
    error: opts.error ? { message: opts.error } : undefined,
    location: { file: "/repo/e2e/login.spec.ts", line: 12, column: 5 },
  };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function installFetchMock(status = 200, jsonBody: unknown = { recordingId: "rec-1" }) {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const body = JSON.stringify(jsonBody);
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

describe("DiffDeckReporter", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;

  afterEach(() => {
    fetchMock?.restore();
  });

  it("uploads a recording with the expected multipart fields and step metadata", async () => {
    fetchMock = installFetchMock();
    const reporter = new DiffDeckReporter({
      host: "https://diffdeck.example/",
      token: "tok_123",
      branch: "feature/login",
      commitSha: "abc1234",
    });

    const test = fakeTest();
    const result = fakeResult();

    reporter.onBegin(fakeConfig(), {} as any);

    const outer = step({ title: "sign in", category: "test.step", offsetMs: 100, duration: 400 });
    const inner = step({
      title: 'expect(page).toHaveURL("/dashboard")',
      category: "expect",
      offsetMs: 300,
      duration: 50,
      parent: outer,
    });

    reporter.onStepBegin(test, result, outer);
    reporter.onStepBegin(test, result, inner);
    reporter.onStepEnd(test, result, inner);
    reporter.onStepEnd(test, result, outer);

    await reporter.onTestEnd(test, result);

    assert.equal(fetchMock.calls.length, 1, "exactly one upload");
    const call = fetchMock.calls[0];

    // URL + auth header.
    assert.equal(call.url, "https://diffdeck.example/api/products/ui-review/recordings");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["X-UI-Review-Token"], "tok_123");
    assert.equal(call.init.method, "POST");

    // Multipart fields.
    const form = call.init.body as FormData;
    const video = form.get("video");
    assert.ok(video instanceof Blob, "video is a Blob");
    assert.equal((video as Blob).type, "video/webm");
    assert.equal((video as Blob).size, Buffer.from("FAKEVIDEOBYTES").byteLength);
    assert.equal(form.get("videoType"), "video/webm");
    assert.equal(form.get("testTitle"), "logs in successfully");
    assert.equal(form.get("testFile"), "e2e/login.spec.ts"); // made relative to rootDir
    assert.equal(form.get("testId"), "test-abc");
    assert.equal(form.get("status"), "passed");
    assert.equal(form.get("durationMs"), "1500");
    assert.equal(form.get("retries"), "0");
    assert.equal(form.get("branch"), "feature/login");
    assert.equal(form.get("commitSha"), "abc1234");

    // Step-timeline metadata shape.
    const metadata = JSON.parse(String(form.get("metadata"))) as RecordingMetadata;
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.reporter, "@diffdeckai/playwright-reporter");
    assert.equal(typeof metadata.reporterVersion, "string");
    assert.equal(metadata.recordingStartTime, TEST_START.toISOString());
    assert.equal(metadata.testDurationMs, 1500);
    assert.equal(metadata.steps.length, 2);

    const [s0, s1] = metadata.steps;
    assert.deepEqual(
      { title: s0.title, category: s0.category, startMs: s0.startMs, endMs: s0.endMs, durationMs: s0.durationMs, depth: s0.depth },
      { title: "sign in", category: "test.step", startMs: 100, endMs: 500, durationMs: 400, depth: 0 }
    );
    assert.deepEqual(
      { title: s1.title, category: s1.category, startMs: s1.startMs, endMs: s1.endMs, durationMs: s1.durationMs, depth: s1.depth },
      {
        title: 'expect(page).toHaveURL("/dashboard")',
        category: "expect",
        startMs: 300,
        endMs: 350,
        durationMs: 50,
        depth: 1,
      }
    );
    assert.equal(s0.location, "/repo/e2e/login.spec.ts:12:5");
  });

  it("captures step error messages", async () => {
    fetchMock = installFetchMock();
    const reporter = new DiffDeckReporter({ host: "https://h", token: "t" });
    const test = fakeTest();
    const result = fakeResult();
    reporter.onBegin(fakeConfig(), {} as any);

    const failing = step({
      title: "click submit",
      category: "test.step",
      offsetMs: 0,
      duration: 10,
      error: "locator.click: timeout",
    });
    reporter.onStepBegin(test, result, failing);
    reporter.onStepEnd(test, result, failing);
    await reporter.onTestEnd(test, result);

    const form = fetchMock.calls[0].init.body as FormData;
    const metadata = JSON.parse(String(form.get("metadata"))) as RecordingMetadata;
    assert.equal(metadata.steps[0].error, "locator.click: timeout");
  });

  it("respects the stepCategories filter", async () => {
    fetchMock = installFetchMock();
    const reporter = new DiffDeckReporter({
      host: "https://h",
      token: "t",
      stepCategories: ["test.step"],
    });
    const test = fakeTest();
    const result = fakeResult();
    reporter.onBegin(fakeConfig(), {} as any);

    const kept = step({ title: "do thing", category: "test.step", offsetMs: 0, duration: 5 });
    const dropped = step({ title: "pw call", category: "pw:api", offsetMs: 1, duration: 1 });
    for (const s of [kept, dropped]) {
      reporter.onStepBegin(test, result, s);
      reporter.onStepEnd(test, result, s);
    }
    await reporter.onTestEnd(test, result);

    const form = fetchMock.calls[0].init.body as FormData;
    const metadata = JSON.parse(String(form.get("metadata"))) as RecordingMetadata;
    assert.equal(metadata.steps.length, 1);
    assert.equal(metadata.steps[0].category, "test.step");
  });

  it("handles the 402 recordings gate gracefully and stops uploading", async () => {
    fetchMock = installFetchMock(402, { error: "Recordings are not enabled" });
    const reporter = new DiffDeckReporter({ host: "https://h", token: "t" });
    reporter.onBegin(fakeConfig(), {} as any);

    await reporter.onTestEnd(fakeTest(), fakeResult());
    // Second test must NOT trigger another request once gated.
    await reporter.onTestEnd(fakeTest(), fakeResult());

    assert.equal(fetchMock.calls.length, 1, "stops after the 402");
  });

  it("skips upload when no token is configured", async () => {
    fetchMock = installFetchMock();
    const reporter = new DiffDeckReporter({ host: "https://h" }); // no token
    reporter.onBegin(fakeConfig(), {} as any);
    await reporter.onTestEnd(fakeTest(), fakeResult());
    assert.equal(fetchMock.calls.length, 0);
  });

  it("skips tests without a video attachment", async () => {
    fetchMock = installFetchMock();
    const reporter = new DiffDeckReporter({ host: "https://h", token: "t" });
    reporter.onBegin(fakeConfig(), {} as any);
    const result = fakeResult();
    result.attachments = [];
    await reporter.onTestEnd(fakeTest(), result);
    assert.equal(fetchMock.calls.length, 0);
  });
});

describe("buildRecordingForm", () => {
  it("omits optional fields that are not provided", () => {
    const upload: RecordingUpload = {
      video: Buffer.from("x"),
      videoType: "video/mp4",
      filename: "v.mp4",
      testTitle: "t",
      metadata: {
        schemaVersion: 1,
        reporter: "@diffdeckai/playwright-reporter",
        reporterVersion: "0.0.0",
        recordingStartTime: TEST_START.toISOString(),
        testDurationMs: 0,
        steps: [],
      },
    };
    const form = buildRecordingForm(upload);
    assert.equal(form.get("testTitle"), "t");
    assert.equal(form.get("videoType"), "video/mp4");
    assert.equal(form.get("branch"), null);
    assert.equal(form.get("commitSha"), null);
    assert.equal(form.get("status"), null);
    assert.ok(form.get("video") instanceof Blob);
  });
});
