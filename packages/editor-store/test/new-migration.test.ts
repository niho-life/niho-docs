import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { MIGRATION_FILE_PATTERN, defaultMigrationsDir } from "../src/migrate.ts";
import { migrationName, stamp, template } from "../src/new-migration-cli.ts";

describe("the generated migration name", () => {
  it("is a 14-digit Asia/Tokyo stamp and the given name", () => {
    // 2026-11-01 01:00:55 JST は UTC では 10-31 16:00:55
    const name = migrationName("recipes", new Date("2026-10-31T16:00:55Z"));
    assert.equal(name, "20261101010055_recipes.sql");
    assert.equal(stamp(new Date("2026-10-31T16:00:55Z")), "20261101010055");
  });

  it("matches the pattern the applier uses", () => {
    const name = migrationName("folders_and_order", new Date());
    assert.ok(MIGRATION_FILE_PATTERN.test(name), name);
  });

  it("sorts after every sequential migration, so the old ones keep running first", async () => {
    const existing = (await readdir(defaultMigrationsDir)).filter((name) => MIGRATION_FILE_PATTERN.test(name));
    assert.ok(existing.length > 0, "there should be migrations to compare against");
    const fresh = migrationName("later", new Date());
    for (const name of existing) {
      assert.ok(name < fresh, `${name} should sort before ${fresh}`);
    }
    // 連番と日時を混ぜても、連番がすべて先に並ぶ
    const sorted = [...existing, fresh].sort();
    assert.equal(sorted.at(-1), fresh);
  });

  it("refuses a name that would not be readable as a file or in SQL", () => {
    for (const bad of ["", "Recipes", "recipes folders", "recipes-folders", "_recipes", "recipes_", "日本語"]) {
      assert.throws(() => migrationName(bad, new Date()), /lowercase letters, digits and _/, bad);
    }
  });

  it("writes a body the applier accepts (wrapped in BEGIN; … COMMIT;)", () => {
    const body = template("recipes");
    assert.match(body, /^\s*BEGIN;\s*\n[\s\S]*\n\s*COMMIT;\s*$/);
  });
});
