/**
 * 段落の中の語単位の差分（AI の提案の「消す文・足す文」。設計 §6・Issue #38）。
 *
 * 形は docs-ui の ShellDiffPart と同じ: 変わらない部分は文字列、消す部分は `{ del }`、足す部分は `{ ins }`。
 * `del` を除いて連結すると変更後、`ins` を除いて連結すると変更前の文になる。
 */
export type DiffPart = string | { del: string } | { ins: string };

/** LCS の表の大きさの上限（これを超える組み合わせは「全部消して全部足す」にする）。 */
export const MAX_DIFF_CELLS = 4_000_000;

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });

/** 語・空白・句読点の並び（全部を連結すると元の文に戻る）。 */
export function tokenize(text: string): string[] {
  return Array.from(segmenter.segment(text), (segment) => segment.segment);
}

type Op = { kind: "same" | "del" | "ins"; text: string };

/** 変わらない部分の間にある消す・足すを 1 つずつにまとめる（消す → 足すの順）。 */
function collect(ops: readonly Op[]): DiffPart[] {
  const parts: DiffPart[] = [];
  let same = "";
  let del = "";
  let ins = "";
  const flushChange = () => {
    if (del) parts.push({ del });
    if (ins) parts.push({ ins });
    del = "";
    ins = "";
  };
  for (const op of ops) {
    if (op.kind === "same") {
      if (del || ins) flushChange();
      same += op.text;
      continue;
    }
    if (same) parts.push(same);
    same = "";
    if (op.kind === "del") del += op.text;
    else ins += op.text;
  }
  if (del || ins) flushChange();
  if (same) parts.push(same);
  return parts;
}

/** 前と後ろの共通部分を除いた残りの LCS（表は後ろからの LCS の長さ）。 */
function lcsOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // n × m ≦ MAX_DIFF_CELLS なので LCS の長さは min(n, m) ≦ 2000 で Uint16 に収まる
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      ops.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "ins", text: b[j]! });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ kind: "del", text: a[i]! });
  for (; j < m; j++) ops.push({ kind: "ins", text: b[j]! });
  return ops;
}

/** 2 つの文の語単位の差分。同じ文なら変わらない部分 1 つ（空同士は []）。 */
export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [before] : [];
  const a = tokenize(before);
  const b = tokenize(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const middle: Op[] =
    middleA.length * middleB.length > MAX_DIFF_CELLS
      ? [
          { kind: "del", text: middleA.join("") },
          { kind: "ins", text: middleB.join("") },
        ]
      : lcsOps(middleA, middleB);
  return collect([
    { kind: "same", text: a.slice(0, start).join("") },
    ...middle,
    { kind: "same", text: a.slice(endA).join("") },
  ]);
}

/** 差分から変更前の文（`ins` を除いて連結）。 */
export function diffBefore(parts: readonly DiffPart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : "del" in part ? part.del : "")).join("");
}

/** 差分から変更後の文（`del` を除いて連結）。 */
export function diffAfter(parts: readonly DiffPart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : "ins" in part ? part.ins : "")).join("");
}
