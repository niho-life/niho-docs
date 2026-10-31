import { describe, expect, it, vi } from "vitest";
import { CLOUD_TASKS_ORIGIN, CloudTasksError, METADATA_TOKEN_URL } from "../server/cloud-tasks";
import {
  CloudTasksTranscriptionQueue,
  DISPATCH_MARGIN_SECONDS,
  TRANSCRIBE_RUN_PATH,
  dispatchDeadlineSeconds,
  resolveTranscriptionTasksConfig,
  transcriptionTaskName,
  type TranscriptionTasksConfig,
} from "./cloud-tasks";

// 合成の値だけ（本物のプロジェクト・URL・メール・トークンを入れない）
const CONFIG: TranscriptionTasksConfig = {
  queue: "projects/synthetic-project/locations/asia-northeast1/queues/synthetic-transcribe",
  workerUrl: "https://worker.example.test",
  invokerServiceAccount: "synthetic-tasks@synthetic-project.iam.gserviceaccount.com",
};
const ENV = {
  EDITOR_TRANSCRIBE_QUEUE: CONFIG.queue,
  EDITOR_TRANSCRIBE_WORKER_URL: CONFIG.workerUrl,
  EDITOR_TRANSCRIBE_INVOKER_SA: CONFIG.invokerServiceAccount,
};
const RUN_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const SECRET_BODY = "leak-check-response-body";

type Call = { url: string; init: RequestInit };

function fakeGoogle(tasks?: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const call = { url: String(input), init };
    calls.push(call);
    if (call.url === METADATA_TOKEN_URL) return Response.json({ access_token: "synthetic-access-token", expires_in: 3599, token_type: "Bearer" });
    if (call.url.startsWith(`${CLOUD_TASKS_ORIGIN}/`)) return tasks ? tasks(call) : Response.json({ name: "created" });
    throw new Error("unexpected host");
  });
  return { fetch: fn as unknown as typeof fetch, calls, taskCalls: () => calls.filter((call) => call.url !== METADATA_TOKEN_URL) };
}

type TaskBody = {
  task: {
    name: string;
    dispatchDeadline: string;
    httpRequest: { url: string; httpMethod: string; body: string; oidcToken: { serviceAccountEmail: string; audience: string } };
  };
};

const bodyOf = (call: Call) => JSON.parse(String(call.init.body)) as TaskBody;

describe("resolveTranscriptionTasksConfig", () => {
  it("is set only when the queue, the worker URL and the invoker service account are all present and well formed", () => {
    expect(resolveTranscriptionTasksConfig(ENV)).toEqual(CONFIG);
    for (const name of Object.keys(ENV) as (keyof typeof ENV)[]) {
      expect(resolveTranscriptionTasksConfig({ ...ENV, [name]: undefined }), name).toBeNull();
      expect(resolveTranscriptionTasksConfig({ ...ENV, [name]: "" }), name).toBeNull();
    }
    expect(resolveTranscriptionTasksConfig({ ...ENV, EDITOR_TRANSCRIBE_QUEUE: "synthetic-transcribe" })).toBeNull();
    expect(resolveTranscriptionTasksConfig({ ...ENV, EDITOR_TRANSCRIBE_WORKER_URL: "http://worker.example.test" })).toBeNull();
    expect(resolveTranscriptionTasksConfig({ ...ENV, EDITOR_TRANSCRIBE_INVOKER_SA: "someone@example.test" })).toBeNull();
    // 手順（#37）の 3 つでは開かない（別のキューなので、別の変数で渡す）
    expect(
      resolveTranscriptionTasksConfig({
        EDITOR_STEPS_QUEUE: CONFIG.queue,
        EDITOR_STEPS_WORKER_URL: CONFIG.workerUrl,
        EDITOR_STEPS_INVOKER_SA: CONFIG.invokerServiceAccount,
      }),
    ).toBeNull();
  });
});

describe("transcriptionTaskName", () => {
  it("names a task after the run and its generation, with Cloud Tasks' characters only", () => {
    expect(transcriptionTaskName(RUN_ID, 0)).toBe(`${RUN_ID}-0`);
    expect(transcriptionTaskName(RUN_ID, 2)).toBe(`${RUN_ID}-2`);
    expect(transcriptionTaskName(RUN_ID, 0)).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
  });
});

describe("dispatchDeadlineSeconds", () => {
  it("is the engine timeout plus the margin, capped at the 1800 seconds Cloud Tasks allows", () => {
    expect(dispatchDeadlineSeconds(1_200_000)).toBe(1200 + DISPATCH_MARGIN_SECONDS);
    expect(dispatchDeadlineSeconds(60_000)).toBe(60 + DISPATCH_MARGIN_SECONDS);
    // 既定の上限（3300 秒）では task の上限に収まらない: Cloud Tasks の最大で止める（run は時間切れで自分で終わる）
    expect(dispatchDeadlineSeconds(3_300_000)).toBe(1800);
    expect(dispatchDeadlineSeconds(1_700_000)).toBe(1800);
  });
});

describe("CloudTasksTranscriptionQueue", () => {
  it("creates an HTTP task for the worker route with the OIDC token, the deadline and a body of the run id only", async () => {
    const google = fakeGoogle();
    const queue = new CloudTasksTranscriptionQueue(CONFIG, { timeoutMs: 1_200_000, fetch: google.fetch });
    const name = transcriptionTaskName(RUN_ID, 0);
    expect(await queue.enqueue({ name, runId: RUN_ID })).toEqual({ deduplicated: false });

    const call = google.taskCalls()[0]!;
    expect(call.url).toBe(`${CLOUD_TASKS_ORIGIN}/v2/${CONFIG.queue}/tasks`);
    const { task } = bodyOf(call);
    expect(task.name).toBe(`${CONFIG.queue}/tasks/${name}`);
    expect(task.dispatchDeadline).toBe(`${1200 + DISPATCH_MARGIN_SECONDS}s`);
    expect(task.httpRequest.url).toBe(`${CONFIG.workerUrl}${TRANSCRIBE_RUN_PATH}`);
    expect(task.httpRequest.httpMethod).toBe("POST");
    expect(task.httpRequest.oidcToken).toEqual({ serviceAccountEmail: CONFIG.invokerServiceAccount, audience: CONFIG.workerUrl });
    // 本文は run の id だけ（音声・鍵・ページの本文は入れない）
    expect(JSON.parse(Buffer.from(task.httpRequest.body, "base64").toString("utf8"))).toEqual({ runId: RUN_ID });
  });

  it("treats 409 ALREADY_EXISTS as already queued (the start and the sweep use the same name)", async () => {
    const google = fakeGoogle(() => Response.json({ error: { status: "ALREADY_EXISTS", message: SECRET_BODY } }, { status: 409 }));
    const queue = new CloudTasksTranscriptionQueue(CONFIG, { timeoutMs: 1_200_000, fetch: google.fetch });
    expect(await queue.enqueue({ name: transcriptionTaskName(RUN_ID, 0), runId: RUN_ID })).toEqual({ deduplicated: true });
  });

  it("fails with a short code only, never the response body", async () => {
    const google = fakeGoogle(() => Response.json({ error: { status: "PERMISSION_DENIED", message: SECRET_BODY } }, { status: 403 }));
    const queue = new CloudTasksTranscriptionQueue(CONFIG, { timeoutMs: 1_200_000, fetch: google.fetch });
    await expect(queue.enqueue({ name: transcriptionTaskName(RUN_ID, 0), runId: RUN_ID })).rejects.toMatchObject({ code: "tasks_http_403" });
    try {
      await queue.enqueue({ name: transcriptionTaskName(RUN_ID, 0), runId: RUN_ID });
    } catch (error) {
      expect(error).toBeInstanceOf(CloudTasksError);
      expect(`${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`).not.toContain(SECRET_BODY);
    }
  });

  it("refuses a malformed task before any request", async () => {
    const google = fakeGoogle();
    const queue = new CloudTasksTranscriptionQueue(CONFIG, { timeoutMs: 1_200_000, fetch: google.fetch });
    for (const task of [
      { name: transcriptionTaskName(RUN_ID, 0), runId: "not-a-uuid" },
      { name: "has space", runId: RUN_ID },
      { name: "../../evil", runId: RUN_ID },
      { name: "", runId: RUN_ID },
    ]) {
      await expect(queue.enqueue(task)).rejects.toMatchObject({ code: "tasks_invalid_task" });
    }
    expect(google.calls).toHaveLength(0);
  });
});
