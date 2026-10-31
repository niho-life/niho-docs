/**
 * 音声ファイルの長さ（秒）を、ブラウザの `<audio>` にメタデータだけ読ませて調べる（#36 段 3b-1。6 時間の上限の事前検査と、
 * 録音の長さの申告のため）。分からない（読めない形式・時間切れ・Chrome の webm の Infinity）なら null で、長さは送らない。
 * `blob:` の URL は CSP の `media-src 'self' blob:` の範囲。調べ終えたら URL を捨てる。
 */
export const AUDIO_DURATION_TIMEOUT_MS = 5000;

export function probeAudioDuration(blob: Blob, options: { timeoutMs?: number } = {}): Promise<number | null> {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let url: string;
    try {
      url = URL.createObjectURL(blob);
    } catch {
      resolve(null);
      return;
    }
    const audio = document.createElement("audio");
    let done = false;
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? AUDIO_DURATION_TIMEOUT_MS);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const { duration } = audio;
      finish(Number.isFinite(duration) && duration > 0 ? duration : null);
    };
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}
