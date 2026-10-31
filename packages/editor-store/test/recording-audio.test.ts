import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readMigrations } from "../src/migrate.ts";
import { AUDIO_OBJECT_PREFIX, audioInfo, audioObjectPath, completeAudioUpload } from "../src/recording-audio.ts";
import type { Connectable } from "../src/recordings.ts";
import type { Queryable } from "../src/types.ts";

function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("0008_recording_audio.sql", () => {
  it("only adds audio columns and constraints to page_recordings, keeping every existing row", async () => {
    const file = (await readMigrations()).find((item) => item.name === "0008_recording_audio.sql");
    assert.ok(file, "0008 is in the ordered list");
    const sql = withoutComments(file.sql);
    for (const column of [
      "ADD COLUMN audio_asset uuid",
      "ADD COLUMN audio_status text NOT NULL DEFAULT 'none'",
      "ADD COLUMN audio_expires_at timestamptz",
      "ADD COLUMN audio_upload_key uuid",
      "ADD COLUMN audio_request_hash text",
    ]) {
      assert.ok(sql.includes(column), column);
    }
    assert.match(sql, /CHECK \(audio_status IN \('none', 'uploading', 'uploaded'\)\)/);
    assert.match(sql, /CHECK \(audio_request_hash IS NULL OR audio_request_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    assert.match(sql, /CHECK \(\(audio_status = 'none'\) = \(audio_asset IS NULL\)\)/);
    // 「音声のない音声由来の録音」（音声が期限で消えた録音、複製のコピー）を許すため、source と audio_status を結ぶ CHECK は持たない
    assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /source <> 'audio'/);
    assert.match(sql, /FOREIGN KEY \(owner, audio_asset\) REFERENCES assets \(owner, id\) DEFERRABLE INITIALLY DEFERRED/);
    assert.match(sql, /UNIQUE \(owner, audio_upload_key\)/);
    assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bINSERT\s+INTO\b/i, "0008 must keep every existing row");
    // DEFERRED にする理由を SQL に残している
    assert.match(file.sql, /DEFERRABLE INITIALLY DEFERRED にする理由/);
  });
});

describe("recording audio without a database", () => {
  const untouchable = {
    query: () => {
      throw new Error("must not reach the database");
    },
    connect: () => {
      throw new Error("must not reach the database");
    },
  };

  it("builds the object path under audio/ from a UUID only", () => {
    assert.equal(AUDIO_OBJECT_PREFIX, "audio/");
    assert.equal(audioObjectPath("6F1D0D7C-6F6C-4C39-9A52-6A1F3B1C0D11"), "audio/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11");
    for (const id of ["", "x", "../etc", "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11/..", "gs://bucket/a"]) {
      assert.throws(() => audioObjectPath(id), TypeError, id);
    }
  });

  it("treats ids that are not UUIDs as missing without querying", async () => {
    for (const id of ["", "not-a-uuid", "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11' OR '1'='1"]) {
      assert.equal(await audioInfo(untouchable as unknown as Queryable, "stub-user", id), null);
      assert.equal(await completeAudioUpload(untouchable as unknown as Connectable, "stub-user", id, { sizeBytes: 1 }), null);
    }
  });
});
