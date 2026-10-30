import type { ShellStepState } from "./types";

export type ShellStep = { id: string; label: string; state: ShellStepState };

const SAY: Record<ShellStepState, string> = { done: "済み", run: "作成中", wait: "待機" };

/** 録音から作る手順（文字起こし › 文字起こし修正 › 記事方針 › 記事本文）。手順ごとにページになり、押すとそのページへ行く。 */
export function ShellSteps({
  steps,
  currentId,
  onSelect,
  onRedo,
}: {
  steps: ShellStep[];
  currentId?: string;
  onSelect?: (id: string) => void;
  /** 手順のサブページで出す「この手順を作り直す」。 */
  onRedo?: () => void;
}) {
  return (
    <>
      <ol className="es-steps" aria-label="手順">
        {steps.map((step) => (
          <li key={step.id}>
            <button
              type="button"
              className={`es-step es-step--${step.state}${step.id === currentId ? " es-step--cur" : ""}`}
              aria-current={step.id === currentId ? "step" : undefined}
              onClick={() => onSelect?.(step.id)}
            >
              <i aria-hidden="true" />
              {step.label}
              <small>{SAY[step.state]}</small>
            </button>
          </li>
        ))}
      </ol>
      {onRedo && (
        <div className="es-redo">
          <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={onRedo}>
            この手順を作り直す
          </button>
        </div>
      )}
    </>
  );
}
