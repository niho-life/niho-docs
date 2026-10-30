import { Icon } from "./icons";

/** 差分の一片。文字列はそのまま、del は消す文（赤）、ins は足す文（緑）。 */
export type ShellDiffPart = string | { del: string } | { ins: string };
export type ShellProposalBlock = {
  id: string;
  parts: ShellDiffPart[];
  /** 採用した・そのままにした段落。 */
  done?: boolean;
  /** 変更の無い段落に添える一言（例: 変更なし）。 */
  note?: string;
};

export type ShellProposalProps = {
  label: string;
  blocks: ShellProposalBlock[];
  onAccept?: (blockId: string) => void;
  onKeep?: (blockId: string) => void;
  onAcceptAll?: () => void;
  onClose?: () => void;
};

/** AI の提案をページの上で見る帯。消す文は赤、足す文は緑。段落ごとに採用できる。 */
export function ShellProposal({ label, blocks, onAccept, onKeep, onAcceptAll, onClose }: ShellProposalProps) {
  return (
    <section className="es-prop" aria-label={`${label} の提案`}>
      <div className="es-prop-hd">
        <Icon name="spark" />
        {label}
        <span className="es-sp" />
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={onClose}>
          閉じる
        </button>
        <button type="button" className="es-btn es-btn--primary es-btn--sm" onClick={onAcceptAll}>
          すべて採用
        </button>
      </div>
      {blocks.map((block) => (
        <div key={block.id} className={`es-blk es-ja${block.done ? " es-blk--done" : ""}`}>
          {block.parts.map((part, index) =>
            typeof part === "string" ? (
              part
            ) : "del" in part ? (
              <del key={index}>{part.del}</del>
            ) : (
              <ins key={index}>{part.ins}</ins>
            ),
          )}
          {!block.done && !block.note && (
            <div className="es-acts">
              <button type="button" className="es-ok" onClick={() => onAccept?.(block.id)}>
                採用
              </button>
              <button type="button" onClick={() => onKeep?.(block.id)}>
                そのまま
              </button>
            </div>
          )}
          {block.note && <p className="es-note">{block.note}</p>}
        </div>
      ))}
    </section>
  );
}
