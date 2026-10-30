import type { Block } from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import { buildProposal, buildRequest } from "./engine";
import { FAKE_MODEL_NAME, createFakeModel } from "./fake-model";
import type { AiOutput, AiRequest } from "./model";
import { PRESET_IDS, type AiIntent } from "./presets";

const p = (value: string): Block => ({ type: "paragraph", content: [{ type: "text", text: value }] });
const heading = (value: string): Block => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: value }] });
const blocks: Block[] = [p("合成の  一段落目"), heading("合成の見出し"), p("すでに整っています。"), p("Synthetic  English line")];

function requestOf(intent: AiIntent, body: Block[] = blocks, lang: "ja" | "en" = "ja"): AiRequest {
  const plan = buildRequest({ blocks: body, lang }, intent);
  if (!plan.ok) throw new Error("expected a plan");
  return plan.requests[0]!;
}

async function run(intent: AiIntent, body: Block[] = blocks): Promise<{ output: AiOutput }> {
  const result = await createFakeModel().run(requestOf(intent, body));
  return { output: result.output as AiOutput };
}

describe("fake model", () => {
  it("tidies spaces and adds 。 only to Japanese paragraphs that need it, marked as fake", async () => {
    const { output } = await run({ preset: "tidy" });
    expect(output).toEqual({
      edits: [
        { index: 0, text: "[fake] 合成の 一段落目。" },
        { index: 3, text: "[fake] Synthetic English line" },
      ],
      inserts: [],
    });
  });

  it("adds a summary at the top, a heading before the first paragraph, and callouts after it", async () => {
    expect((await run({ preset: "summarize" })).output).toEqual({ edits: [], inserts: [{ afterIndex: -1, kind: "paragraph", text: "要約（fake）: 合成の 一段落目" }] });
    expect((await run({ preset: "headings" })).output).toEqual({ edits: [], inserts: [{ afterIndex: -1, kind: "heading", text: "見出し案（fake）" }] });
    expect((await run({ preset: "addHeadings" }, [heading("h"), p("body")])).output).toEqual({ edits: [], inserts: [{ afterIndex: 0, kind: "heading", text: "見出し案（fake）" }] });
    expect((await run({ preset: "articleIdeas" })).output.inserts).toEqual([{ afterIndex: 0, kind: "callout", text: "記事にできそうな部分（fake）: 合成の 一段落目" }]);
    expect((await run({ preset: "checkFacts" })).output.inserts).toEqual([{ afterIndex: 0, kind: "callout", text: "Check facts to confirm (fake): 合成の 一段落目" }]);
    const long = (await run({ preset: "summarize" }, [p("あ".repeat(40))])).output;
    expect(long.inserts[0]?.text).toBe(`要約（fake）: ${"あ".repeat(30)}…`);
  });

  it("prefixes every paragraph with text for the translations", async () => {
    const { output } = await run({ preset: "toEnglish" }, [p("一"), { type: "paragraph" }, heading("二")]);
    expect(output).toEqual({ edits: [{ index: 0, text: "[fake EN] 一" }, { index: 2, text: "[fake EN] 二" }], inserts: [] });
    expect((await run({ preset: "toJapanese" }, [p("one")])).output.edits).toEqual([{ index: 0, text: "[fake JA] one" }]);
  });

  it("appends the free text to the first editable paragraph", async () => {
    const { output } = await run({ text: "合成の直したいことを二十文字より長く書いておく" });
    expect(output).toEqual({ edits: [{ index: 0, text: "[fake] 合成の  一段落目（直したいこと: 合成の直したいことを二十文字より長く書い…）" }], inserts: [] });
  });

  it("is deterministic, reports fake usage as a quarter of the characters, and every output passes the engine", async () => {
    for (const id of PRESET_IDS) {
      const intent: AiIntent = { preset: id };
      const request = requestOf(intent);
      const first = await createFakeModel().run(request);
      const second = await createFakeModel().run(request);
      expect(second).toEqual(first);
      expect(first.usage.model).toBe(FAKE_MODEL_NAME);
      const output = first.output as AiOutput;
      for (const item of [...output.edits, ...output.inserts]) expect(item.text, id).toMatch(/fake/);
      const sent = request.paragraphs.reduce((sum, paragraph) => sum + Array.from(paragraph.text).length, 0);
      const returned = [...output.edits, ...output.inserts].reduce((sum, item) => sum + Array.from(item.text).length, 0);
      expect(first.usage).toEqual({ model: "fake", inputTokens: Math.ceil(sent / 4), outputTokens: Math.ceil(returned / 4) });
      expect(buildProposal(blocks, [{ request, output: first.output }], intent, 1).ok, id).toBe(true);
    }
  });

  it("returns nothing for a page without paragraphs and stops when aborted", async () => {
    expect((await run({ preset: "summarize" }, [{ type: "horizontalRule" }, { type: "bulletList", content: [{ type: "listItem", content: [p("項目")] }] }])).output).toEqual({ edits: [], inserts: [] });
    const controller = new AbortController();
    controller.abort();
    await expect(createFakeModel().run(requestOf({ preset: "tidy" }), controller.signal)).rejects.toThrow();
  });
});
