import type { Pool } from "pg";

/** ページの種類（見た目と初期値を決めるだけで、あとから変えられる）。設計 §3。 */
export const PAGE_KINDS = ["note", "journal", "rec", "article", "step"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export const PAGE_LANGS = ["ja", "en"] as const;
export type PageLang = (typeof PAGE_LANGS)[number];

export const STEP_STATUSES = ["done", "run", "wait", "stale"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/**
 * 本文のブロック。ここでは「JSON の値の配列」としてだけ扱う（中身の形はエディタ側の schema が決める）。
 * 限定 AST としての厳密な検証は #33 で足す。
 */
export type Block = { readonly [key: string]: unknown };

/** NIHO の安定したユーザー ID（認証の後でだけ得る）。メール・名前ではない。 */
export type OwnerId = string;

export type Page = {
  id: string;
  kind: PageKind;
  title: string;
  lang: PageLang;
  blocks: Block[];
  cover: string | null;
  lead: string | null;
  parent: string | null;
  recipe: string | null;
  stepStatus: StepStatus | null;
  createdAt: string;
  updatedAt: string;
};

/** 一覧の 1 行（本文は含めない）。 */
export type PageSummary = Pick<Page, "id" | "kind" | "title" | "lang" | "createdAt" | "updatedAt">;

export type CreatePageInput = {
  kind?: PageKind;
  title?: string;
  lang?: PageLang;
  blocks?: Block[];
};

/** 部分更新。指定したものだけを変える。 */
export type PagePatch = {
  kind?: PageKind;
  title?: string;
  lang?: PageLang;
  blocks?: Block[];
};

/** pg の Pool / PoolClient のうち、このパッケージが使う部分。 */
export type Queryable = Pick<Pool, "query">;
