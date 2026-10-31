//! Mac の殻（設計 §13・#45 の T7）。
//!
//! Mac アプリは editor.niho.life を読む殻で、端末の力（録音・端末内の文字起こし・CLI の AI）だけを bridge で足す。
//! この module は殻の入口だけを持つ：どの画面を読むか（`NIHO_DOCS_SHELL`）と、画面が殻を見分けるための
//! `shell_capabilities`。URL は**ここの定数だけ**で、環境変数やページから URL を受け取らない。
//!
//! remote origin から呼べるコマンドは `capabilities/remote-editor.json`（本番は editor.niho.life だけ）で決まる。
//! 開発の `localhost` は `capabilities/remote-editor-dev.json` に分け、`tauri.dev.conf.json` を付けたときだけ入る
//! （配布物の `tauri.conf.json` は `default` と `remote-editor` だけを数える。acl_tests.rs が固定する）。

use serde::Serialize;

use crate::CommandResult;

/// 本番の画面。配布物の殻が読むのはこれだけ。
pub const EDITOR_URL: &str = "https://editor.niho.life";
/// 開発の画面（`npm -C apps/editor-web run dev`）。開発・試験の起動でだけ使える。
pub const DEV_EDITOR_URL: &str = "http://localhost:3000";
/// どの画面を読むかの環境変数。`remote`＝editor.niho.life、`dev`＝開発の画面（開発の起動だけ）、それ以外＝今までの画面。
pub const SHELL_ENV: &str = "NIHO_DOCS_SHELL";

/// 殻が読む画面。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellMode {
  /// 今までの画面（同梱の index.html。旧 NIHO docs。殻に置き換わるまでの既定）。
  Local,
  /// editor.niho.life。
  Remote,
  /// 開発の editor（localhost）。開発・試験の起動でだけ選べる。
  Dev,
}

/// `NIHO_DOCS_SHELL` の値と、開発の起動かどうかから、読む画面を決める。知らない値・本番での `dev` は今までの画面。
pub fn shell_mode(value: Option<&str>, dev: bool) -> ShellMode {
  match value.map(str::trim) {
    Some("remote") => ShellMode::Remote,
    Some("dev") if dev => ShellMode::Dev,
    _ => ShellMode::Local,
  }
}

/// 殻が開く URL。今までの画面なら None（同梱の index.html のまま）。
pub fn remote_url(mode: ShellMode) -> Option<tauri::Url> {
  let url = match mode {
    ShellMode::Local => return None,
    ShellMode::Remote => EDITOR_URL,
    ShellMode::Dev => DEV_EDITOR_URL,
  };
  // 定数なので必ず読める。万一読めなければ起動を止めず、今までの画面に落とす
  tauri::Url::parse(url).ok()
}

/// この Mac にある端末の力（画面が「この Mac で」の選択肢を出す判断に使う）。
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellFeatures {
  /// マイクの録音（`niho-speech record`）。
  pub recording: bool,
  /// 端末内の文字起こし（同梱の `niho-speech`）。
  pub local_transcription: bool,
  /// CLI の AI（Claude Code・Codex CLI・Antigravity CLI）。
  pub cli_ai: bool,
}

/// 殻の自己紹介。画面はこれが返ることで「Mac の殻の中にいる」と分かる（capability が無ければ呼べず、ブラウザでは無い）。
/// 鍵・パス・端末の名前は入れない。
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellCapabilities {
  /// アプリの版（Cargo.toml。配布の版と同じ）。
  pub version: String,
  /// 開発・試験の起動か。
  pub dev: bool,
  pub features: ShellFeatures,
}

/// 殻の自己紹介を組む（command と test で同じものを使う）。
pub fn capabilities(dev: bool) -> ShellCapabilities {
  ShellCapabilities {
    version: env!("CARGO_PKG_VERSION").to_string(),
    dev,
    // 第 1 段では「ある」ことだけ返す。実際に使える状態か（マイクの許可・音声モデル・CLI のログイン）は、
    // それぞれの command が呼ばれたときに今までどおり確かめる
    features: ShellFeatures { recording: true, local_transcription: true, cli_ai: true },
  }
}

/// editor.niho.life の画面から呼ぶ、殻の自己紹介。
#[tauri::command]
pub async fn shell_capabilities() -> CommandResult<ShellCapabilities> {
  Ok(capabilities(crate::is_dev_launch()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn remote_is_the_production_editor_only() {
    assert_eq!(shell_mode(Some("remote"), false), ShellMode::Remote);
    assert_eq!(shell_mode(Some("remote"), true), ShellMode::Remote);
    assert_eq!(remote_url(ShellMode::Remote).unwrap().as_str(), "https://editor.niho.life/");
  }

  #[test]
  fn dev_editor_is_only_for_dev_launches() {
    assert_eq!(shell_mode(Some("dev"), true), ShellMode::Dev);
    assert_eq!(remote_url(ShellMode::Dev).unwrap().as_str(), "http://localhost:3000/");
    // 本番の起動で dev を指定しても、開発の画面は読まない
    assert_eq!(shell_mode(Some("dev"), false), ShellMode::Local);
  }

  #[test]
  fn anything_else_keeps_the_bundled_screen() {
    for value in [None, Some(""), Some("local"), Some("https://example.com"), Some("REMOTE")] {
      assert_eq!(shell_mode(value, true), ShellMode::Local, "{value:?}");
    }
    assert_eq!(remote_url(ShellMode::Local), None);
  }

  #[test]
  fn capabilities_carry_no_paths_or_secrets() {
    let json = serde_json::to_value(capabilities(false)).unwrap();
    assert_eq!(json["dev"], serde_json::json!(false));
    assert_eq!(json["features"], serde_json::json!({ "recording": true, "localTranscription": true, "cliAi": true }));
    assert_eq!(json["version"], serde_json::json!(env!("CARGO_PKG_VERSION")));
    assert_eq!(json.as_object().unwrap().len(), 3);
  }
}
