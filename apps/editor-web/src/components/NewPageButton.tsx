"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createPageRequest } from "@/lib/pages-client";

/** 「新しいページ」。押すと空のページを作り、そのページへ移る。 */
export function NewPageButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const create = async () => {
    setState("busy");
    try {
      const id = await createPageRequest();
      router.push(`/p/${id}`);
    } catch {
      setState("error");
    }
  };
  return (
    <>
      <button type="button" onClick={create} disabled={state === "busy"} aria-busy={state === "busy" || undefined}>
        新しいページ
      </button>
      {state === "error" && <p role="alert">ページを作れませんでした。もう一度お試しください。</p>}
    </>
  );
}
