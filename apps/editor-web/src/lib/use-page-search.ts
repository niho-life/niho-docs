import { useEffect, useMemo, useState } from "react";
import { SEARCH_QUERY_MAX_CHARS, SearchRequestError, normalizeSearchInput, searchRequest, type SearchHit } from "./search-client";

/** 打つのが止まってから要求を出すまでの時間。 */
export const SEARCH_DEBOUNCE_MS = 150;

export type PageSearchStatus = "idle" | "loading" | "ready" | "error";
export type PageSearchError = "too_long" | "unauthorized" | "unavailable" | "failed";

export type PageSearchState = {
  /** idle: 検索語が空 / loading: 待っている・問い合わせ中（前の結果を出したまま）/ ready: 結果あり / error: 失敗。 */
  status: PageSearchStatus;
  results: readonly SearchHit[];
  error: PageSearchError | null;
};

type Settled = { query: string; results: readonly SearchHit[]; error: PageSearchError | null };

const NO_RESULTS: readonly SearchHit[] = Object.freeze([]);
const IDLE: PageSearchState = Object.freeze({ status: "idle", results: NO_RESULTS, error: null });
const TOO_LONG: PageSearchState = Object.freeze({ status: "error", results: NO_RESULTS, error: "too_long" });

function errorCode(error: unknown): PageSearchError {
  if (error instanceof SearchRequestError) {
    if (error.status === 401) return "unauthorized";
    if (error.status === 503) return "unavailable";
  }
  return "failed";
}

/**
 * 打つたびに自分のページを探す（⌘K・サイドバーの検索）。
 * 打つのが SEARCH_DEBOUNCE_MS 止まってから 1 回だけ問い合わせ、検索語が変わったら前の要求は中止して捨てる。
 * 空（空白だけを含む）では問い合わせない。長すぎる語は問い合わせずに error（too_long）。
 */
export function usePageSearch(query: string, options: { limit?: number } = {}): PageSearchState {
  const normalized = normalizeSearchInput(query);
  const tooLong = Array.from(normalized).length > SEARCH_QUERY_MAX_CHARS;
  const { limit } = options;
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (normalized === "" || tooLong) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchRequest(normalized, limit === undefined ? { signal: controller.signal } : { limit, signal: controller.signal }).then(
        (results) => {
          if (!controller.signal.aborted) setSettled({ query: normalized, results, error: null });
        },
        (error: unknown) => {
          // 中止した要求（古い検索語）の結果・失敗は捨てる
          if (!controller.signal.aborted) setSettled({ query: normalized, results: NO_RESULTS, error: errorCode(error) });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [normalized, tooLong, limit]);

  return useMemo<PageSearchState>(() => {
    if (normalized === "") return IDLE;
    if (tooLong) return TOO_LONG;
    if (settled?.query === normalized) {
      return settled.error ? { status: "error", results: NO_RESULTS, error: settled.error } : { status: "ready", results: settled.results, error: null };
    }
    // 新しい語の結果が来るまでは前の結果を出したままにする（打つたびに一覧が空にならないように）
    return { status: "loading", results: settled?.error ? NO_RESULTS : (settled?.results ?? NO_RESULTS), error: null };
  }, [normalized, tooLong, settled]);
}
