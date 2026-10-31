import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_TASKS_ORIGIN,
  CloudTasksError,
  CloudTasksQueue,
  DISPATCH_DEADLINE,
  METADATA_TOKEN_URL,
  MetadataTokenSource,
  WORKER_RUN_PATH,
  resolveCloudTasksConfig,
  type CloudTasksConfig,
} from "./cloud-tasks";
import { taskName } from "./queue";

// 合成の値だけ（本物のプロジェクト・URL・メール・トークンを入れない）
const CONFIG: CloudTasksConfig = {
  queue: "projects/synthetic-project/locations/asia-northeast1/queues/synthetic-queue",
  workerUrl: "https://worker.example.test",
  invokerServiceAccount: "synthetic-tasks@synthetic-project.iam.gserviceaccount.com",
};
const ENV = {
  EDITOR_STEPS_QUEUE: CONFIG.queue,
  EDITOR_STEPS_WORKER_URL: CONFIG.workerUrl,
  EDITOR_STEPS_INVOKER_SA: CONFIG.invokerServiceAccount,
};
const RUN_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const NOW = Date.UTC(2026, 9, 31, 3, 0, 0);
const SECRET_BODY = "leak-check-response-body";

type Call = { url: string; init: RequestInit };

/** メタデータサーバーと Cloud Tasks の偽物。`tasks` で Cloud Tasks の応答を差し替える。 */
function fakeGoogle(options: { tasks?: (call: Call) => Response | Promise<Response>; token?: () => Response | Promise<Response>; expiresIn?: number } = {}) {
  const calls: Call[] = [];
  let issued = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const call = { url: String(input), init };
    calls.push(call);
    if (call.url === METADATA_TOKEN_URL) {
      if (options.token) return options.token();
      issued += 1;
      return Response.json({ access_token: `synthetic-access-token-${issued}`, expires_in: options.expiresIn ?? 3599, token_type: "Bearer" });
    }
    if (call.url.startsWith(`${CLOUD_TASKS_ORIGIN}/`)) return options.tasks ? options.tasks(call) : Response.json({ name: "created" });
    throw new Error("unexpected host");
  });
  return {
    fetch: fn as unknown as typeof fetch,
    calls,
    tokenCalls: () => calls.filter((call) => call.url === METADATA_TOKEN_URL),
    taskCalls: () => calls.filter((call) => call.url !== METADATA_TOKEN_URL),
  };
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

type TaskBody = {
  task: {
    name: string;
    scheduleTime?: string;
    dispatchDeadline: string;
    httpRequest: { url: string; httpMethod: string; headers: Record<string, string>; body: string; oidcToken: { serviceAccountEmail: string; audience: string } };
  };
};

const bodyOf = (call: Call) => JSON.parse(String(call.init.body)) as TaskBody;

function queueWith(google: ReturnType<typeof fakeGoogle>, clock = { now: NOW }) {
  return { queue: new CloudTasksQueue(CONFIG, { fetch: google.fetch, now: () => clock.now }), clock };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CloudTasksError);
    const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
    // 例外に応答の本文・トークンを入れない
    expect(text).not.toContain(SECRET_BODY);
    expect(text).not.toContain("synthetic-access-token");
    return (error as CloudTasksError).code;
  }
  throw new Error("expected a CloudTasksError");
}

describe("resolveCloudTasksConfig", () => {
  it("is set only when the queue, the worker URL and the invoker service account are all present and well formed", () => {
    expect(resolveCloudTasksConfig(ENV)).toEqual(CONFIG);
    expect(resolveCloudTasksConfig({ ...ENV, EDITOR_STEPS_WORKER_URL: `${CONFIG.workerUrl}/` })).toEqual(CONFIG);
    for (const name of Object.keys(ENV) as (keyof typeof ENV)[]) {
      expect(resolveCloudTasksConfig({ ...ENV, [name]: undefined }), name).toBeNull();
      expect(resolveCloudTasksConfig({ ...ENV, [name]: "" }), name).toBeNull();
    }
    for (const queue of [
      "synthetic-queue",
      "projects/synthetic-project/locations/asia-northeast1/queues/",
      "projects/synthetic-project/locations/asia-northeast1/queues/q/tasks/x",
      "projects/../locations/asia-northeast1/queues/synthetic-queue",
      "projects/synthetic-project/locations/asia-northeast1/queues/synthetic queue",
      "projects/Synthetic-Project/locations/asia-northeast1/queues/synthetic-queue",
      `${CONFIG.queue}?x=1`,
    ]) {
      expect(resolveCloudTasksConfig({ ...ENV, EDITOR_STEPS_QUEUE: queue }), queue).toBeNull();
    }
    for (const url of [
      "http://worker.example.test",
      "https://worker.example.test/api",
      "https://worker.example.test/?a=1",
      "https://worker.example.test/#x",
      "https://user:pass@worker.example.test",
      "https://WORKER.example.test",
      "worker.example.test",
      "not a url",
    ]) {
      expect(resolveCloudTasksConfig({ ...ENV, EDITOR_STEPS_WORKER_URL: url }), url).toBeNull();
    }
    for (const email of [
      "synthetic-tasks@gmail.example.test",
      "someone@example.test",
      "Synthetic-Tasks@synthetic-project.iam.gserviceaccount.com",
      "synthetic-tasks@synthetic-project.iam.gserviceaccount.com.example.test",
      "synthetic-tasks",
    ]) {
      expect(resolveCloudTasksConfig({ ...ENV, EDITOR_STEPS_INVOKER_SA: email }), email).toBeNull();
    }
  });
});

describe("CloudTasksQueue", () => {
  it("creates an HTTP task on the fixed Cloud Tasks host with the OIDC token, the deadline and a base64 body", async () => {
    const google = fakeGoogle();
    const { queue } = queueWith(google);
    const name = taskName(RUN_ID, 1, 0);
    expect(await queue.enqueue({ name, runId: RUN_ID, stepIndex: 1 })).toEqual({ deduplicated: false });

    const [token] = google.tokenCalls();
    expect(token?.url).toBe("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
    expect(headerOf(token!.init, "metadata-flavor")).toBe("Google");

    const [call] = google.taskCalls();
    expect(call?.url).toBe(`https://cloudtasks.googleapis.com/v2/${CONFIG.queue}/tasks`);
    expect(new URL(call!.url).host).toBe("cloudtasks.googleapis.com");
    expect(call?.init.method).toBe("POST");
    expect(headerOf(call!.init, "authorization")).toBe("Bearer synthetic-access-token-1");
    expect(headerOf(call!.init, "content-type")).toBe("application/json");
    const body = bodyOf(call!);
    expect(body).toEqual({
      task: {
        name: `${CONFIG.queue}/tasks/${RUN_ID}-1-0`,
        dispatchDeadline: DISPATCH_DEADLINE,
        httpRequest: {
          url: `https://worker.example.test${WORKER_RUN_PATH}`,
          httpMethod: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.any(String),
          oidcToken: { serviceAccountEmail: CONFIG.invokerServiceAccount, audience: CONFIG.workerUrl },
        },
      },
    });
    expect(DISPATCH_DEADLINE).toBe("1800s");
    expect(JSON.parse(Buffer.from(body.task.httpRequest.body, "base64").toString("utf8"))).toEqual({ runId: RUN_ID, stepIndex: 1 });
    expect(body.task.scheduleTime).toBeUndefined();
  });

  it("expresses delaySeconds as scheduleTime", async () => {
    const google = fakeGoogle();
    const { queue } = queueWith(google);
    await queue.enqueue({ name: taskName(RUN_ID, 0, 1), runId: RUN_ID, stepIndex: 0, delaySeconds: 20 });
    expect(bodyOf(google.taskCalls()[0]!).task.scheduleTime).toBe(new Date(NOW + 20_000).toISOString());
    expect(bodyOf(google.taskCalls()[0]!).task.name).toBe(`${CONFIG.queue}/tasks/${RUN_ID}-0-1`);
  });

  it("caches the metadata access token until 60 seconds before it expires, and shares one fetch between concurrent calls", async () => {
    const google = fakeGoogle({ expiresIn: 600 });
    const { queue, clock } = queueWith(google);
    await Promise.all([0, 1, 2].map((stepIndex) => queue.enqueue({ name: taskName(RUN_ID, stepIndex, 0), runId: RUN_ID, stepIndex })));
    expect(google.tokenCalls()).toHaveLength(1);
    clock.now = NOW + 539_000;
    await queue.enqueue({ name: taskName(RUN_ID, 3, 0), runId: RUN_ID, stepIndex: 3 });
    expect(google.tokenCalls()).toHaveLength(1);
    clock.now = NOW + 540_000;
    await queue.enqueue({ name: taskName(RUN_ID, 4, 0), runId: RUN_ID, stepIndex: 4 });
    expect(google.tokenCalls()).toHaveLength(2);
    expect(headerOf(google.taskCalls().at(-1)!.init, "authorization")).toBe("Bearer synthetic-access-token-2");
  });

  it("drops the cached token when Cloud Tasks refuses it (401), so the next call fetches a new one", async () => {
    let refuse = true;
    const google = fakeGoogle({ tasks: () => (refuse ? new Response(SECRET_BODY, { status: 401 }) : Response.json({})) });
    const { queue } = queueWith(google);
    expect(await codeOf(queue.enqueue({ name: taskName(RUN_ID, 0, 0), runId: RUN_ID, stepIndex: 0 }))).toBe("tasks_http_401");
    refuse = false;
    await queue.enqueue({ name: taskName(RUN_ID, 0, 0), runId: RUN_ID, stepIndex: 0 });
    expect(google.tokenCalls()).toHaveLength(2);
  });

  it("treats 409 ALREADY_EXISTS as already queued, and any other failure as an error with a short code only", async () => {
    const respond = { current: (): Response => Response.json({ error: { code: 409, status: "ALREADY_EXISTS", message: SECRET_BODY } }, { status: 409 }) };
    const google = fakeGoogle({ tasks: () => respond.current() });
    const { queue } = queueWith(google);
    const task = { name: taskName(RUN_ID, 0, 0), runId: RUN_ID, stepIndex: 0 };
    expect(await queue.enqueue(task)).toEqual({ deduplicated: true });

    const failures: [() => Response | Promise<Response>, string][] = [
      // ABORTED も 409 になる（積み済みとはみなさない）
      [() => Response.json({ error: { code: 409, status: "ABORTED", message: SECRET_BODY } }, { status: 409 }), "tasks_http_409"],
      [() => new Response(SECRET_BODY, { status: 409 }), "tasks_http_409"],
      [() => Response.json({ error: { code: 403, status: "PERMISSION_DENIED", message: SECRET_BODY } }, { status: 403 }), "tasks_http_403"],
      [() => Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: SECRET_BODY } }, { status: 400 }), "tasks_http_400"],
      [() => new Response(SECRET_BODY, { status: 503 }), "tasks_http_503"],
      [() => Promise.reject(new TypeError(SECRET_BODY)), "tasks_network"],
    ];
    for (const [response, code] of failures) {
      respond.current = response as () => Response;
      expect(await codeOf(queue.enqueue(task))).toBe(code);
    }
  });

  it("fails with a short code when the metadata server does not give a token, and sends nothing to Cloud Tasks", async () => {
    const cases: [() => Response | Promise<Response>, string][] = [
      [() => new Response(SECRET_BODY, { status: 500 }), "tasks_token_http_500"],
      [() => new Response(SECRET_BODY, { status: 200 }), "tasks_token_invalid"],
      [() => Response.json({ access_token: "", expires_in: 3599 }), "tasks_token_invalid"],
      [() => Response.json({ access_token: "has space", expires_in: 3599 }), "tasks_token_invalid"],
      [() => Response.json({ access_token: "synthetic-access-token-x", expires_in: "3599" }), "tasks_token_invalid"],
      [() => Response.json({ access_token: "synthetic-access-token-x", expires_in: 0 }), "tasks_token_invalid"],
      [() => Promise.reject(new TypeError(SECRET_BODY)), "tasks_token_network"],
    ];
    for (const [token, code] of cases) {
      const google = fakeGoogle({ token });
      const { queue } = queueWith(google);
      expect(await codeOf(queue.enqueue({ name: taskName(RUN_ID, 0, 0), runId: RUN_ID, stepIndex: 0 }))).toBe(code);
      expect(google.taskCalls()).toHaveLength(0);
    }
  });

  it("refuses malformed tasks before any request", async () => {
    const google = fakeGoogle();
    const { queue } = queueWith(google);
    for (const task of [
      { name: "has space", runId: RUN_ID, stepIndex: 0 },
      { name: "../../evil", runId: RUN_ID, stepIndex: 0 },
      { name: "", runId: RUN_ID, stepIndex: 0 },
      { name: "n".repeat(501), runId: RUN_ID, stepIndex: 0 },
      { name: "ok", runId: "not-a-uuid", stepIndex: 0 },
      { name: "ok", runId: RUN_ID, stepIndex: -1 },
      { name: "ok", runId: RUN_ID, stepIndex: 1.5 },
      { name: "ok", runId: RUN_ID, stepIndex: 0, delaySeconds: -1 },
      { name: "ok", runId: RUN_ID, stepIndex: 0, delaySeconds: Number.NaN },
    ]) {
      expect(await codeOf(queue.enqueue(task))).toBe("tasks_invalid_task");
    }
    expect(google.calls).toHaveLength(0);
  });

  it("uses one token source for the metadata server only (never another host)", async () => {
    const google = fakeGoogle();
    const tokens = new MetadataTokenSource({ fetch: google.fetch, now: () => NOW });
    expect(await tokens.token()).toBe("synthetic-access-token-1");
    expect(await tokens.token()).toBe("synthetic-access-token-1");
    tokens.invalidate();
    expect(await tokens.token()).toBe("synthetic-access-token-2");
    expect(new Set(google.calls.map((call) => call.url))).toEqual(new Set([METADATA_TOKEN_URL]));
  });
});
