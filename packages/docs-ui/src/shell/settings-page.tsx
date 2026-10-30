import { Icon } from "./icons";
import { ShellField, ShellKv, ShellKvs, ShellPills, ShellSection, ShellSettingsPage, ShellToggle } from "./settings-parts";

export type SettingsAiLang = "same" | "ja" | "en";
export type SettingsEngine = "mac" | "gemini" | "deepgram";
export type SettingsSaveTo = "cloud" | "mac";
export type SettingsProfileField = "name" | "titleJa" | "titleEn" | "bio";

export type SettingsPageProps = {
  profile: { initial: string; name: string; titleJa: string; titleEn: string; bio: string };
  onProfile?: (field: SettingsProfileField, value: string) => void;
  onChangePhoto?: () => void;
  /** AI の提案の言語。 */
  aiLang: SettingsAiLang;
  onAiLang?: (lang: SettingsAiLang) => void;
  /** 固有名詞（録音の文字起こしと AI の提案が引き継ぐ）。 */
  terms: string;
  onEditTerms?: () => void;
  /** 手順（録音から作る流れ）。steps は「文字起こし ›」のあとの名前。 */
  recipes: { id: string; name: string; steps: string[] }[];
  onEditRecipe?: (id: string) => void;
  onAddRecipe?: () => void;
  engine: SettingsEngine;
  onEngine?: (engine: SettingsEngine) => void;
  /** 話者の推定。 */
  speakers: boolean;
  onSpeakers?: (on: boolean) => void;
  saveTo: SettingsSaveTo;
  onSaveTo?: (to: SettingsSaveTo) => void;
  onExportAll?: () => void;
  onLogout?: () => void;
};

const NAV = [
  { id: "es-s-prof", label: "プロフィール" },
  { id: "es-s-ai", label: "AI" },
  { id: "es-s-steps", label: "手順" },
  { id: "es-s-tr", label: "文字起こし" },
  { id: "es-s-save", label: "保存" },
];

/**
 * 設定（モック v6 の V.settings）。プロフィール・AI・手順・文字起こし・保存の 5 節と、上の項目帯（押すとその節へ）。
 * 語彙はモックのまま（既存の Mac の設定画面とは別の画面。差し替えは #45）。
 */
export function SettingsPage(props: SettingsPageProps) {
  const { profile } = props;
  return (
    <ShellSettingsPage title="設定" nav={NAV}>
      <ShellSection id="es-s-prof" title="プロフィール">
        <div className="es-form">
          <div className="es-profile-row">
            <span className="es-av es-av--xl" aria-hidden="true">
              {profile.initial}
            </span>
            <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={props.onChangePhoto}>
              写真を変更
            </button>
          </div>
          <ShellField label="名前" value={profile.name} onChange={(value) => props.onProfile?.("name", value)} />
          <ShellField label="肩書き（日本語）" value={profile.titleJa} onChange={(value) => props.onProfile?.("titleJa", value)} />
          <ShellField label="肩書き（English）" value={profile.titleEn} onChange={(value) => props.onProfile?.("titleEn", value)} />
          <ShellField label="紹介" value={profile.bio} multiline onChange={(value) => props.onProfile?.("bio", value)} />
        </div>
      </ShellSection>
      <ShellSection id="es-s-ai" title="AI">
        <ShellKvs>
          <ShellKv label="提案の言語">
            <ShellPills
              label="提案の言語"
              value={props.aiLang}
              onChange={props.onAiLang}
              options={[
                { id: "same", label: "書いた言語のまま" },
                { id: "ja", label: "日本語" },
                { id: "en", label: "English" },
              ]}
            />
          </ShellKv>
          <ShellKv label="固有名詞">
            <code>{props.terms}</code>
            <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="固有名詞を編集" onClick={props.onEditTerms}>
              編集
            </button>
          </ShellKv>
        </ShellKvs>
      </ShellSection>
      <ShellSection id="es-s-steps" title="手順">
        <ShellKvs>
          {props.recipes.map((recipe) => (
            <ShellKv key={recipe.id} label={recipe.name}>
              <span>文字起こし › {recipe.steps.join(" › ")}</span>
              <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label={`${recipe.name}を編集`} onClick={() => props.onEditRecipe?.(recipe.id)}>
                編集
              </button>
            </ShellKv>
          ))}
        </ShellKvs>
        <div className="es-kvs-add">
          <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={props.onAddRecipe}>
            <Icon name="plus" />
            手順を追加
          </button>
        </div>
      </ShellSection>
      <ShellSection id="es-s-tr" title="文字起こし">
        <ShellKvs>
          <ShellKv label="エンジン">
            <ShellPills
              label="エンジン"
              value={props.engine}
              onChange={props.onEngine}
              options={[
                { id: "mac", label: "この Mac" },
                { id: "gemini", label: "Gemini" },
                { id: "deepgram", label: "Deepgram" },
              ]}
            />
          </ShellKv>
          <ShellKv label="話者の推定">
            <ShellToggle checked={props.speakers} label="話者の推定" onChange={props.onSpeakers} />
          </ShellKv>
        </ShellKvs>
      </ShellSection>
      <ShellSection id="es-s-save" title="保存">
        <ShellKvs>
          <ShellKv label="保存先">
            <ShellPills
              label="保存先"
              value={props.saveTo}
              onChange={props.onSaveTo}
              options={[
                { id: "cloud", label: "NIHO クラウド" },
                { id: "mac", label: "この Mac だけ" },
              ]}
            />
          </ShellKv>
          <ShellKv label="書き出し">
            <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={props.onExportAll}>
              すべてのページを書き出す
            </button>
          </ShellKv>
        </ShellKvs>
      </ShellSection>
      <ShellSection>
        <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={props.onLogout}>
          ログアウト
        </button>
      </ShellSection>
    </ShellSettingsPage>
  );
}
