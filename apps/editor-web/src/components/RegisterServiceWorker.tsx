"use client";

import { useEffect } from "react";

/**
 * 本番だけ service worker（public/sw.js）を登録する。開発では HMR と競合するので登録しない。
 * 登録に失敗しても（http・古いブラウザ・拒否）アプリは今までどおり動く。
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}
