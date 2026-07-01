# @diffdeckai/playwright-reporter

A [Playwright](https://playwright.dev) reporter that uploads each test's **video recording** — together with a **per-step timeline** — to [DiffDeck](https://diffdeck.ai). DiffDeck hosts the videos and renders the step timeline over them so you can scrub a failing run step by step.

The reporter does not run or change your tests. It hooks into Playwright's reporting lifecycle: on each test end it finds the recorded video attachment, packages the step timing it captured via `onStepBegin`/`onStepEnd`, and `POST`s both to your DiffDeck repository.

## Install

```bash
npm install --save-dev @diffdeckai/playwright-reporter
```

`@playwright/test` is a peer dependency (Playwright `>=1.30`).

## Configure

Add the reporter to `playwright.config.ts` and make sure Playwright is **recording video** (the reporter has nothing to upload otherwise):

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: {
    video: "on", // or "retain-on-failure"
  },
  reporter: [
    ["list"],
    ["@diffdeckai/playwright-reporter", { host: "https://diffdeck.ai" }],
  ],
});
```

Options can also come entirely from the environment, so CI needs no config change:

```ts
reporter: [["list"], ["@diffdeckai/playwright-reporter"]],
```

### Options

All options are optional and fall back to environment variables.

| Option           | Type       | Env fallback                                                                       | Default              | Description                                                                                  |
| ---------------- | ---------- | ---------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `host`           | `string`   | `DIFFDECK_HOST`                                                                    | `https://diffdeck.ai` | DiffDeck base URL. Recordings are POSTed to `<host>/api/products/ui-review/recordings`.       |
| `token`          | `string`   | `DIFFDECK_TOKEN`                                                                   | —                    | Per-repo project token, sent as the `X-UI-Review-Token` header. **Required** to upload.       |
| `branch`         | `string`   | `DIFFDECK_BRANCH`, `GITHUB_HEAD_REF`, `GITHUB_REF_NAME`, `CI_COMMIT_REF_NAME`, `GIT_BRANCH` | —          | Git branch tagged on each recording.                                                          |
| `commitSha`      | `string`   | `DIFFDECK_COMMIT`, `GITHUB_SHA`, `CI_COMMIT_SHA`, `GIT_COMMIT`                      | —                    | Git commit SHA tagged on each recording.                                                      |
| `stepCategories` | `string[]` | —                                                                                  | all categories       | If set, only steps with these Playwright categories are captured (e.g. `["test.step","expect"]`). |
| `quiet`          | `boolean`  | —                                                                                  | `false`              | Silence the reporter's console output.                                                        |

### Environment variables

The only thing CI must provide is the token (and usually the host):

```bash
export DIFFDECK_TOKEN="your-repo-project-token"
export DIFFDECK_HOST="https://diffdeck.ai"   # optional; this is the default
```

If no token is found, the reporter logs a one-time warning and uploads nothing — your test run is never failed by a missing token.

## What gets uploaded

For each completed test that has a video, the reporter sends a `multipart/form-data` request:

| Field        | Source                                              |
| ------------ | --------------------------------------------------- |
| `video`      | the recorded video blob (`video/webm` or `video/mp4`) |
| `videoType`  | the video MIME type                                 |
| `testTitle`  | `test.title`                                        |
| `testFile`   | spec file, relative to the Playwright `rootDir`     |
| `testId`     | `test.id`                                            |
| `status`     | `passed` \| `failed` \| `timedOut` \| `skipped` \| `interrupted` |
| `durationMs` | `result.duration`                                   |
| `retries`    | `result.retry`                                      |
| `branch`     | resolved branch (see options)                       |
| `commitSha`  | resolved commit (see options)                       |
| `metadata`   | JSON string — the step-timeline document (below)    |

Authentication is the `X-UI-Review-Token` header.

If the repository does not have the DiffDeck recordings add-on enabled, the route responds `402`. The reporter treats this as a soft signal: it logs once and stops uploading for the rest of the run, without failing the test run.

## Step-timeline metadata shape

The `metadata` field is a JSON document describing the per-step timeline. This is the data the DiffDeck player renders over the video. All step times are in **milliseconds relative to the start of the recording**, where the recording start equals the test's `startTime` (`recordingStartTime`).

```jsonc
{
  "schemaVersion": 1,
  "reporter": "@diffdeckai/playwright-reporter",
  "reporterVersion": "0.1.0",
  "recordingStartTime": "2026-06-30T12:00:00.000Z", // ISO; timeline zero point
  "testDurationMs": 1500,
  "steps": [
    {
      "title": "sign in",            // step label
      "category": "test.step",       // test.step | expect | pw:api | hook | fixture | ...
      "startMs": 100,                // offset from recordingStartTime (>= 0)
      "endMs": 500,                  // offset from recordingStartTime (>= startMs)
      "durationMs": 400,             // endMs - startMs
      "depth": 0,                    // nesting depth (0 = top level)
      "location": "e2e/login.spec.ts:12:5", // optional source location
      "error": "locator.click: timeout"     // optional; present only on failed steps
    },
    {
      "title": "expect(page).toHaveURL(\"/dashboard\")",
      "category": "expect",
      "startMs": 300,
      "endMs": 350,
      "durationMs": 50,
      "depth": 1
    }
  ]
}
```

TypeScript types for this document are exported from the package:

```ts
import type { RecordingMetadata, RecordingStep } from "@diffdeckai/playwright-reporter";
import { RECORDING_METADATA_SCHEMA_VERSION } from "@diffdeckai/playwright-reporter";
```

### Notes on alignment

- `startMs`/`endMs` are computed from each step's `startTime` minus the test's `startTime`, then clamped to `>= 0`. The test start time is the best alignment to the video that Playwright exposes; sub-frame drift between the first painted frame and `startTime` is expected and small.
- Steps are ordered by `startMs` (ties keep capture order), and `depth` reflects nesting so a consumer can render the timeline hierarchically.

## Development

```bash
npm install
npm run build       # tsc -> dist/
npm test            # node:test unit tests (mocked fetch)
npm run typecheck
```

## License

[MIT](./LICENSE)
