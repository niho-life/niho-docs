export type LoginScreenProps = {
  /** 「NIHOでログイン」。 */
  onLogin: () => void;
  onCreateAccount?: () => void;
  onHelp?: () => void;
};

/**
 * ログイン（モック v6 の V.login）。左に写真の面（写真は持ち込まず、仮の面）、右に「書く」と NIHO アカウントで続けるボタン。
 * 900px 未満では面が上に出て 1 列になる。パスワードは持たない（NIHO アカウントで続ける）。
 */
export function LoginScreen({ onLogin, onCreateAccount, onHelp }: LoginScreenProps) {
  return (
    <div className="es-root es-root--scroll" data-editor-login>
      <div className="es-split">
        <div className="es-split-ph" aria-hidden="true" />
        <div className="es-split-r">
          {/* 名前（ロゴ）も、どれかのランドマークに入れる（header = banner。main・footer と並ぶ） */}
          <header className="es-lg-brand">
            <span className="es-lg-mark" aria-hidden="true">
              N
            </span>
            <span>
              NIHO <span>editor</span>
            </span>
          </header>
          <main className="es-split-box">
            <h1>書く</h1>
            <p>NIHO アカウントで続けます。</p>
            <button type="button" className="es-btn es-btn--primary es-btn--lg" onClick={onLogin}>
              NIHOでログイン
            </button>
            <div className="es-split-links">
              <button type="button" onClick={onCreateAccount}>
                アカウントを作る
              </button>
              <button type="button" onClick={onHelp}>
                ヘルプ
              </button>
            </div>
          </main>
          <footer className="es-split-foot">
            <span>© NIHO</span>
            <a href="https://niho.life">niho.life</a>
          </footer>
        </div>
      </div>
    </div>
  );
}
