/**
 * 逐次の SHA-256（FIPS 180-4）。依存を足さない自前の実装（#36 段 3b-1）。
 *
 * 録音の音声（2 GiB まで）の申告の sha256 をブラウザで計算するため。`SubtleCrypto.digest` は入力を一度に受け取るので、
 * 大きなファイルを全部メモリに載せずに計算できない。ここは `update` を何度でも呼べ、最後に `digest` で小文字 16 進 64 桁を返す。
 * 正しさは `node:crypto` との突き合わせ（境界の長さ・ランダムな分割・5 MiB 超）と既知のベクタでテストしている（sha256-stream.test.ts）。
 * 入力の長さは 2^53 バイト未満を前提にする（Number で数える）。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
  0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
  0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
  0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] as const;

export class Sha256 {
  private readonly state = new Int32Array(INITIAL);
  private readonly words = new Int32Array(64);
  /** 64 バイトに満たない残り。 */
  private readonly pending = new Uint8Array(64);
  private pendingLength = 0;
  private totalBytes = 0;
  private finished = false;

  /** 続きのバイト列を足す。`digest` のあとは呼べない。 */
  update(data: Uint8Array): this {
    if (this.finished) throw new Error("sha256: update after digest");
    let offset = 0;
    const length = data.length;
    this.totalBytes += length;
    if (this.pendingLength > 0) {
      const take = Math.min(64 - this.pendingLength, length);
      this.pending.set(data.subarray(0, take), this.pendingLength);
      this.pendingLength += take;
      offset = take;
      if (this.pendingLength < 64) return this;
      this.block(this.pending, 0);
      this.pendingLength = 0;
    }
    // 64 バイトそろう部分は写さずにそのまま回す
    while (length - offset >= 64) {
      this.block(data, offset);
      offset += 64;
    }
    if (offset < length) {
      this.pending.set(data.subarray(offset), 0);
      this.pendingLength = length - offset;
    }
    return this;
  }

  /** 小文字 16 進 64 桁。1 度だけ呼べる。 */
  digest(): string {
    if (this.finished) throw new Error("sha256: digest called twice");
    this.finished = true;
    const bits = this.totalBytes * 8;
    // 0x80、0 を詰めて残り 8 バイトに長さ（ビット、ビッグエンディアン）
    const tail = new Uint8Array(this.pendingLength < 56 ? 64 : 128);
    tail.set(this.pending.subarray(0, this.pendingLength), 0);
    tail[this.pendingLength] = 0x80;
    const high = Math.floor(bits / 0x1_0000_0000);
    const low = bits >>> 0;
    const end = tail.length;
    tail[end - 8] = high >>> 24;
    tail[end - 7] = (high >>> 16) & 0xff;
    tail[end - 6] = (high >>> 8) & 0xff;
    tail[end - 5] = high & 0xff;
    tail[end - 4] = low >>> 24;
    tail[end - 3] = (low >>> 16) & 0xff;
    tail[end - 2] = (low >>> 8) & 0xff;
    tail[end - 1] = low & 0xff;
    for (let offset = 0; offset < end; offset += 64) this.block(tail, offset);
    let hex = "";
    for (const word of this.state) hex += (word >>> 0).toString(16).padStart(8, "0");
    return hex;
  }

  /** 64 バイトの 1 ブロックを圧縮関数に通す。 */
  private block(bytes: Uint8Array, offset: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] = (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    const state = this.state;
    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    state[0] = (state[0]! + a) | 0;
    state[1] = (state[1]! + b) | 0;
    state[2] = (state[2]! + c) | 0;
    state[3] = (state[3]! + d) | 0;
    state[4] = (state[4]! + e) | 0;
    state[5] = (state[5]! + f) | 0;
    state[6] = (state[6]! + g) | 0;
    state[7] = (state[7]! + h) | 0;
  }
}

/** 1 度に渡せる小さな入力の SHA-256（テスト・小さな値用）。 */
export function sha256Hex(data: Uint8Array): string {
  return new Sha256().update(data).digest();
}
