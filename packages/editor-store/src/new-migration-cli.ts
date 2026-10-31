/**
 * 新しい migration のファイルを作る（名前は日時から自動で付ける）。
 *
 *   npm -C packages/editor-store run new-migration -- recipes
 *   → packages/editor-store/migrations/20261101153000_recipes.sql（BEGIN; … COMMIT; の雛形）
 *
 * なぜ日時か: 連番（0001・0002…）を人が選ぶと、並行して作業している人が同じ番号を取る。このリポジトリでは実際に
 * 2 回起きた（#90 と #93 が両方 0008、#100 と #93 が両方 0009）。適用は辞書順なので、日時にすれば取り合いが消える
 * （同じ秒に 2 つできても名前が違うので両方入り、順序も決まる）。niho-app（Prisma）も同じ流儀。
 *
 * 既にある連番のファイルは**名前を変えない**。適用済みの名前は editor_store_migrations に記録されていて、
 * 名前を変えると「未適用の新しい migration」に見えるうえ checksum も合わなくなる。連番は履歴として残し、
 * これから作るものだけ日時にする。辞書順では "0" < "2" なので、連番 → 日時の順に並ぶ（混在しても壊れない）。
 */

import { writeFile } from "node:fs/promises";
import { argv, exit, stderr, stdout } from "node:process";
import { defaultMigrationsDir, MIGRATION_FILE_PATTERN } from "./migrate.ts";

/** 名前に使えるのは小文字の英数字と `_`（ファイル名と SQL の読みやすさのため）。 */
const SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** `YYYYMMDDHHMMSS`（Asia/Tokyo。並びが人の感覚と合うように現地時刻で付ける）。 */
export function stamp(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}${get("second")}`;
}

export function migrationName(slug: string, now: Date): string {
  if (!SLUG.test(slug)) throw new Error("the name must be lowercase letters, digits and _ (for example: recipes_and_folders)");
  const name = `${stamp(now)}_${slug}.sql`;
  // 作った名前が適用の規則に合うことを、作る前に確かめる（規則が変わったら気づける）
  if (!MIGRATION_FILE_PATTERN.test(name)) throw new Error(`generated name does not match the applier's pattern: ${name}`);
  return name;
}

/** 雛形。migrate.ts が BEGIN; … COMMIT; で包まれていることを要求する。 */
export function template(slug: string): string {
  return `BEGIN;

-- ${slug}: 何のための変更かを 1〜3 行で書く（なぜ要るか、どの Issue か）。
-- 列を落とすのは expand → contract で、引き継ぎが要らなくなる配備の 1 つ後の別の migration にする。

COMMIT;
`;
}

async function main(): Promise<void> {
  const slug = argv[2];
  if (!slug) {
    stderr.write("usage: npm -C packages/editor-store run new-migration -- <name>\n");
    exit(2);
  }
  const name = migrationName(slug, new Date());
  const url = new URL(name, defaultMigrationsDir);
  // 同じ秒に 2 つ作ったときに黙って上書きしない
  await writeFile(url, template(slug), { encoding: "utf8", flag: "wx" });
  stdout.write(`${name}\n`);
}

if (import.meta.url === `file://${argv[1]}`) {
  await main();
}
