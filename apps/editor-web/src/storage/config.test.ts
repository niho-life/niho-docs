import { describe, expect, it } from "vitest";
import { StorageConfigError, isBucketName, resolveStorageConfig } from "./config";
import { getStorage } from "./runtime";

// bucket 名は明らかなダミーだけ
const BUCKET = "synthetic-test-bucket";

describe("resolveStorageConfig", () => {
  it("refuses fake in production (start fails), whatever the bucket", () => {
    for (const EDITOR_STORAGE of ["fake", " fake "]) {
      expect(() => resolveStorageConfig({ NODE_ENV: "production", EDITOR_STORAGE })).toThrow(StorageConfigError);
      expect(() => resolveStorageConfig({ NODE_ENV: "production", EDITOR_STORAGE, EDITOR_ASSETS_BUCKET: BUCKET })).toThrow(/not allowed when NODE_ENV=production/);
    }
  });

  it("is off in production when unset, empty or off (the audio API answers 503)", () => {
    for (const EDITOR_STORAGE of [undefined, "", "  ", "off"]) {
      expect(resolveStorageConfig({ NODE_ENV: "production", EDITOR_STORAGE }), String(EDITOR_STORAGE)).toEqual({ kind: "off" });
      expect(resolveStorageConfig({ NODE_ENV: "production", EDITOR_STORAGE, EDITOR_ASSETS_BUCKET: BUCKET })).toEqual({ kind: "off" });
    }
  });

  it("is fake outside production when unset, and honours off and fake", () => {
    for (const NODE_ENV of [undefined, "development", "test"]) {
      expect(resolveStorageConfig({ NODE_ENV }), String(NODE_ENV)).toEqual({ kind: "fake" });
      expect(resolveStorageConfig({ NODE_ENV, EDITOR_STORAGE: "" })).toEqual({ kind: "fake" });
      expect(resolveStorageConfig({ NODE_ENV, EDITOR_STORAGE: "fake" })).toEqual({ kind: "fake" });
      expect(resolveStorageConfig({ NODE_ENV, EDITOR_STORAGE: "off" })).toEqual({ kind: "off" });
    }
  });

  it("needs a valid bucket name for gcs, in production and elsewhere, and never puts the value in the message", () => {
    for (const NODE_ENV of ["production", "development"]) {
      expect(resolveStorageConfig({ NODE_ENV, EDITOR_STORAGE: "gcs", EDITOR_ASSETS_BUCKET: ` ${BUCKET} ` })).toEqual({ kind: "gcs", bucket: BUCKET });
      for (const EDITOR_ASSETS_BUCKET of [undefined, "", "  "]) {
        expect(() => resolveStorageConfig({ NODE_ENV, EDITOR_STORAGE: "gcs", EDITOR_ASSETS_BUCKET })).toThrow(/EDITOR_ASSETS_BUCKET is required/);
      }
      for (const EDITOR_ASSETS_BUCKET of ["Synthetic-Test-Bucket", "gs://synthetic-test-bucket", "synthetic/test", "xx"]) {
        let message = "";
        try {
          resolveStorageConfig({ NODE_ENV, EDITOR_STORAGE: "gcs", EDITOR_ASSETS_BUCKET });
        } catch (error) {
          expect(error).toBeInstanceOf(StorageConfigError);
          message = (error as Error).message;
        }
        expect(message, EDITOR_ASSETS_BUCKET).toBe("EDITOR_ASSETS_BUCKET is not a valid bucket name");
      }
    }
  });

  it("throws on an unknown value instead of guessing", () => {
    for (const EDITOR_STORAGE of ["FAKE", "Gcs", "s3", "memory", "true", "1"]) {
      expect(() => resolveStorageConfig({ EDITOR_STORAGE }), EDITOR_STORAGE).toThrow("EDITOR_STORAGE must be one of: fake, gcs, off");
      expect(() => resolveStorageConfig({ NODE_ENV: "production", EDITOR_STORAGE })).toThrow(StorageConfigError);
    }
  });
});

describe("isBucketName", () => {
  it("follows the GCS naming rules", () => {
    for (const name of ["abc", "synthetic-test-bucket", "a_b-c", "a.b.c", `${"a".repeat(63)}`, `${"a".repeat(63)}.${"b".repeat(63)}`]) expect(isBucketName(name), name).toBe(true);
    for (const name of ["ab", "a".repeat(64), "-abc", "abc-", "_abc", "ABC", "a..b", "a.-b", "a b", "203.0.113.7", "goog-synthetic", "my-google-bucket", `${"a".repeat(64)}.b`, `${"a.".repeat(112)}a`]) {
      expect(isBucketName(name), name).toBe(false);
    }
  });
});

describe("getStorage (per request)", () => {
  it("answers null when storage is off, misconfigured, or fake in production, and never throws", () => {
    expect(getStorage({ NODE_ENV: "production" })).toBeNull();
    expect(getStorage({ NODE_ENV: "production", EDITOR_STORAGE: "fake" })).toBeNull();
    expect(getStorage({ NODE_ENV: "development", EDITOR_STORAGE: "off" })).toBeNull();
    expect(getStorage({ NODE_ENV: "development", EDITOR_STORAGE: "nope" })).toBeNull();
    expect(getStorage({ NODE_ENV: "development", EDITOR_STORAGE: "gcs" })).toBeNull();
  });

  it("gives one shared fake outside production, and a GCS storage for gcs (without calling it)", () => {
    const fake = getStorage({ NODE_ENV: "test" });
    expect(fake?.kind).toBe("fake");
    expect(getStorage({ NODE_ENV: "development", EDITOR_STORAGE: "fake" })).toBe(fake);
    const gcs = getStorage({ NODE_ENV: "production", EDITOR_STORAGE: "gcs", EDITOR_ASSETS_BUCKET: BUCKET });
    expect(gcs?.kind).toBe("gcs");
    expect(getStorage({ NODE_ENV: "production", EDITOR_STORAGE: "gcs", EDITOR_ASSETS_BUCKET: BUCKET })).toBe(gcs);
  });
});
