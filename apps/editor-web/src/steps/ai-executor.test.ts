import { describe, expect, it, vi } from "vitest";
import type { AiUsageDelta, AiUsageTotals, Block, OwnerId } from "@niho/editor-store";
import { AnthropicError, type AnthropicClient, type CompleteInput } from "../ai/anthropic";
import type { AiComposeBackend } from "../ai/config";
import { StepError } from "./executor";
import { createAiStepExecutor, type AiStepExecutorDeps, type StepUsageStore } from "./ai-executor";
import { DEFAULT_RECIPES, findRecipeIn } from "./recipes";

// 合成の値だけを使う（本物のモデルは呼ばない）
const OWNER: OwnerId = "synthetic-owner-a";
const MONTH = "2026-11";
const now = () => new Date("2026-11-01T10:00:00+09:00");
const tpl1 = findRecipeIn(DEFAULT_RECIPES, "tpl-1")!;
const transcript: Block[] = [
  { type: "paragraph", content: [{ type: "text", text: "合成の座談会の文字起こし" }] },
  { type: "paragraph", content: [{ type: "text", text: "二つ目の段落" }] },
];

const answer = JSON.stringify({
  blocks: [
    { kind: "heading", level: 2, text: "合成の見出し" },
    { kind: "paragraph", text: "合成の本文" },
  ],
});

/** 送られたプロンプトを覚える偽の 1 往復。 */
function stubClient(reply: () => Promise<{ text: string; usage: { model: string; inputTokens: number; outputTokens: number } }>) {
  const calls: CompleteInput[] = [];
  const client: AnthropicClient = {
    complete: async (input) => {
      calls.push(input);
      return reply();
    },
    // 段階の実行器は 1 往復だけを使う（道具つきの往復は AI チャット）
    converse: async () => {
      throw new Error("the step executor must not use converse");
    },
  };
  return { client, calls };
}

function okClient(text = answer) {
  return stubClient(async () => ({ text, usage: { model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 500 } }));
}

/** 使用量を覚えるだけの偽の store。 */
function memoryUsage(start: Partial<AiUsageTotals> = {}): StepUsageStore & { totals: AiUsageTotals; records: AiUsageDelta[] } {
  const totals: AiUsageTotals = { owner: OWNER, month: MONTH, source: "server", requests: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0, ...start };
  const records: AiUsageDelta[] = [];
  return {
    totals,
    records,
    get: async () => totals,
    record: async (_owner, _month, delta) => {
      records.push(delta);
      totals.requests += delta.requests;
      totals.inputTokens += delta.inputTokens;
      totals.outputTokens += delta.outputTokens;
      totals.costMicroUsd += delta.costMicroUsd;
      return totals;
    },
  };
}

function setup(options: { client?: AnthropicClient; usage?: StepUsageStore | null; limitUsd?: number | null; provider?: "claude" | null } = {}) {
  const backend: AiComposeBackend = {
    client: options.client ?? okClient().client,
    model: "claude-sonnet-5-5",
    provider: options.provider === undefined ? "claude" : options.provider,
    route: "server",
    engine: "anthropic:claude-sonnet-5-5",
  };
  const deps: AiStepExecutorDeps = {
    compose: () => backend,
    usage: () => (options.usage === undefined ? memoryUsage() : options.usage),
    limitUsd: () => options.limitUsd ?? null,
    now,
    env: {},
  };
  return createAiStepExecutor(deps);
}

const input = { recipe: tpl1, stepIndex: 0, owner: OWNER, parentBlocks: transcript, previousBlocks: null };

describe("the real step executor", () => {
  it("turns the model's output into blocks and reports the usage", async () => {
    const executor = setup();
    const output = await executor.run(input);
    expect(output.blocks).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "合成の見出し" }] },
      { type: "paragraph", content: [{ type: "text", text: "合成の本文" }] },
    ]);
    expect(output.usage).toEqual({ inputTokens: 1_000, outputTokens: 500, model: "claude-sonnet-5-5" });
  });

  it("sends the step, the guide and the source of this step (the parent body on step 0, the previous result after it)", async () => {
    const first = okClient();
    await setup({ client: first.client }).run(input);
    expect(first.calls[0]!.user).toContain(`手順「${tpl1.name}」の段階 1/${tpl1.steps.length}「${tpl1.steps[0]!.name}」`);
    expect(first.calls[0]!.user).toContain("合成の座談会の文字起こし\n\n二つ目の段落");

    const second = okClient();
    await setup({ client: second.client }).run({
      ...input,
      stepIndex: 1,
      previousBlocks: [{ type: "paragraph", content: [{ type: "text", text: "段階 1 の結果" }] }],
    });
    expect(second.calls[0]!.user).toContain("### 前の段階の結果");
    expect(second.calls[0]!.user).toContain("段階 1 の結果");
    expect(second.calls[0]!.user).not.toContain("合成の座談会の文字起こし");
  });

  it("records the estimated cost of the call", async () => {
    const usage = memoryUsage();
    await setup({ usage }).run(input);
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]!.requests).toBe(1);
    expect(usage.records[0]!.inputTokens).toBe(1_000);
    // claude-sonnet-5-5: 入力 $2・出力 $10／100 万トークン → 0.002 + 0.005 USD
    expect(usage.records[0]!.costMicroUsd).toBe(7_000);
  });

  it("counts nothing when the model is the fake one (no price list)", async () => {
    const usage = memoryUsage();
    await setup({ usage, provider: null }).run(input);
    expect(usage.records[0]!.costMicroUsd).toBe(0);
  });

  it("stops before calling the model when this month is at or over the limit", async () => {
    const client = okClient();
    const usage = memoryUsage({ costMicroUsd: 10_000_000 });
    const executor = setup({ client: client.client, usage, limitUsd: 10 });
    await expect(executor.run(input)).rejects.toMatchObject({ name: "StepError", code: "quota_exceeded", retryable: false });
    expect(client.calls).toHaveLength(0);
    expect(usage.records).toHaveLength(0);
  });

  it("still calls the model just under the limit", async () => {
    const usage = memoryUsage({ costMicroUsd: 9_999_999 });
    await expect(setup({ usage, limitUsd: 10 }).run(input)).resolves.toMatchObject({ usage: { model: "claude-sonnet-5-5" } });
  });

  it("fails without calling the model when the AI is off or the usage cannot be counted", async () => {
    const executor = createAiStepExecutor({ compose: () => null, usage: () => memoryUsage(), limitUsd: () => null, now, env: {} });
    await expect(executor.run(input)).rejects.toMatchObject({ code: "ai_unavailable", retryable: false });

    const noDb = setup({ usage: null });
    await expect(noDb.run(input)).rejects.toMatchObject({ code: "usage_unavailable", retryable: true });

    // 持ち主が分からない要求（runner は claim の owner を渡す）でもモデルを呼ばない
    const client = okClient();
    await expect(setup({ client: client.client }).run({ ...input, owner: undefined })).rejects.toMatchObject({ code: "usage_unavailable" });
    expect(client.calls).toHaveLength(0);
  });

  it("maps the upstream failure to a short code and keeps the retryable ones retryable", async () => {
    const cases = [
      ["auth", "ai_auth", false],
      ["rate_limit", "ai_rate_limit", true],
      ["overloaded", "ai_overloaded", true],
      ["server", "ai_server", true],
      ["timeout", "ai_timeout", true],
      ["network", "ai_network", true],
      ["bad_request", "ai_bad_request", false],
      ["invalid_output", "invalid_output", false],
    ] as const;
    for (const [kind, code, retryable] of cases) {
      const client = stubClient(async () => {
        throw new AnthropicError(kind);
      });
      await expect(setup({ client: client.client }).run(input)).rejects.toMatchObject({ code, retryable });
    }
  });

  it("records the tokens of a call that answered but could not be used", async () => {
    const usage = memoryUsage();
    const client = stubClient(async () => {
      throw new AnthropicError("invalid_output", { reason: "max_tokens", usage: { model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 12_000 } });
    });
    await expect(setup({ client: client.client, usage }).run(input)).rejects.toMatchObject({ code: "invalid_output" });
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]!.outputTokens).toBe(12_000);
  });

  it("refuses output that is not the documented JSON, and says nothing about its content", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const text of ["これは JSON ではありません", "{}", JSON.stringify({ blocks: [{ kind: "image", text: "x" }] }), JSON.stringify({ blocks: [] })]) {
        const usage = memoryUsage();
        await expect(setup({ client: okClient(text).client, usage }).run(input)).rejects.toMatchObject({ code: "invalid_output", retryable: false });
        // 呼んだ分は数える
        expect(usage.records).toHaveLength(1);
      }
      for (const call of logged.mock.calls) expect(JSON.stringify(call)).not.toContain("これは JSON ではありません");
    } finally {
      logged.mockRestore();
    }
  });

  it("accepts output wrapped in a code fence", async () => {
    const fenced = "```json\n" + answer + "\n```";
    await expect(setup({ client: okClient(fenced).client }).run(input)).resolves.toMatchObject({ usage: { model: "claude-sonnet-5-5" } });
  });

  it("fails for a step the recipe does not have, before anything else", async () => {
    const client = okClient();
    await expect(setup({ client: client.client }).run({ ...input, stepIndex: 99 })).rejects.toMatchObject({ code: "unknown_step", retryable: false });
    expect(client.calls).toHaveLength(0);
  });

  it("stops on the signal of the caller (the lease was lost)", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = okClient();
    await expect(setup({ client: client.client }).run({ ...input, signal: controller.signal })).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
  });

  it("asks the settings for the glossary and the language", async () => {
    const client = okClient();
    const executor = createAiStepExecutor({
      compose: () => ({ client: client.client, model: "claude-sonnet-5-5", provider: "claude", route: "server", engine: "anthropic:claude-sonnet-5-5" }),
      usage: () => memoryUsage(),
      limitUsd: () => null,
      settings: () => async () => ({ aiLang: "en", glossary: [{ term: "NIHO", reading: "ニホ", variants: [], note: "" }], recipes: [], about: "" }),
      now,
      env: {},
    });
    await executor.run(input);
    expect(client.calls[0]!.user).toContain("出力の言語: en");
    expect(client.calls[0]!.user).toContain("NIHO");
  });

  it("sends 「あなたについて」 and the other pages of the folder", async () => {
    const client = okClient();
    const executor = createAiStepExecutor({
      compose: () => ({ client: client.client, model: "claude-sonnet-5-5", provider: "claude", route: "server", engine: "anthropic:claude-sonnet-5-5" }),
      usage: () => memoryUsage(),
      limitUsd: () => null,
      settings: () => async () => ({ aiLang: "same", glossary: [], recipes: [], about: "合成の自己紹介です。" }),
      references: () => async () => [
        { id: "ref-1", title: "同じフォルダのページ", kind: "note", blocks: [{ type: "paragraph", content: [{ type: "text", text: "参考の本文" }] }] },
      ],
      now,
      env: {},
    });
    await executor.run({ ...input, parentPageId: "00000000-0000-4000-8000-0000000000aa" });
    expect(client.calls[0]!.user).toContain("## あなたについて");
    expect(client.calls[0]!.user).toContain("合成の自己紹介です。");
    expect(client.calls[0]!.user).toContain("## 参考（同じフォルダのほかのページ）");
    expect(client.calls[0]!.user).toContain("参考の本文");
  });

  it("runs without them when the settings and the folder cannot be read", async () => {
    const client = okClient();
    await setup({ client: client.client }).run(input);
    expect(client.calls[0]!.user).not.toContain("## あなたについて");
    expect(client.calls[0]!.user).not.toContain("## 参考");
  });

  it("is a StepError for every failure the runner has to classify", async () => {
    const client = stubClient(async () => {
      throw new AnthropicError("server");
    });
    const error = await setup({ client: client.client })
      .run(input)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(StepError);
  });
});
