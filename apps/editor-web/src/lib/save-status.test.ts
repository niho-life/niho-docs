import { describe, expect, it } from "vitest";
import { headerStatus } from "./save-status";

describe("headerStatus", () => {
  it("公開の状態が分からない・公開していないときは「自分だけ · 保存の状態」", () => {
    expect(headerStatus("saved")).toEqual({ state: "private", tip: "自分だけ · 保存済み" });
    expect(headerStatus("saving", { state: "private", tip: "自分だけ · 保存済み" })).toEqual({ state: "private", tip: "自分だけ · 保存中" });
  });

  it("公開しているときは公開の状態と言葉。末尾の固定の「保存済み」は、いまの保存の状態に替える", () => {
    expect(headerStatus("saving", { state: "published", tip: "公開中 · https://niho.life/article/a · 保存済み" })).toEqual({
      state: "published",
      tip: "公開中 · https://niho.life/article/a · 保存中",
    });
    expect(headerStatus("offline", { state: "limited", tip: "限定公開 · URL を知っている人だけ · 保存済み" }).tip).toBe("限定公開 · URL を知っている人だけ · オフライン・この端末に保持");
  });

  it("更新ありは、言葉のあとに保存の状態を足す", () => {
    expect(headerStatus("saved", { state: "updated", tip: "更新あり · 直した内容はまだ読者に出ていません" })).toEqual({
      state: "updated",
      tip: "更新あり · 直した内容はまだ読者に出ていません · 保存済み",
    });
  });
});
