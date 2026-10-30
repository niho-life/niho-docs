/**
 * 貼り付けた HTML を、エディタの schema が読む前に洗う。
 *
 * ProseMirror は schema に無い要素を読み捨てるので script・style の中身は本文に入らないが、読み取りの規則に頼らず、
 * 本文に持ち込めない要素・属性をここで取り除く（`<iframe>`・`<svg>`・`<form>`・`style` の宣言など）。
 * 残す属性は、リンク先（a の href。scheme の検査は schema 側）・番号の開始（ol の start）・
 * Word や Google ドキュメントが太字・斜体を表す style の `font-weight`・`font-style` だけ。
 * 見出し 1 は題名の役なので 2 に、4 以下は 3 にそろえる（schema は 2・3 だけ）。
 */

const DROP_WITH_CONTENT = [
  "script",
  "style",
  "link",
  "meta",
  "base",
  "title",
  "head",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "svg",
  "math",
  "canvas",
  "template",
  "noscript",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "audio",
  "video",
  "img",
  "picture",
  "source",
  "track",
];

const KEPT_STYLE_PROPERTIES = new Set(["font-weight", "font-style"]);
const HEADING_LEVEL: Record<string, string> = { h1: "h2", h4: "h3", h5: "h3", h6: "h3" };

/** style 属性から、太字・斜体を表す宣言だけを残す。 */
function keptStyle(style: string): string {
  return style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const [property = "", ...value] = declaration.split(":");
      return KEPT_STYLE_PROPERTIES.has(property.trim().toLowerCase()) && !/[{}<>\\]|url\(|expression/i.test(value.join(":"));
    })
    .join("; ");
}

function cleanAttributes(element: Element): void {
  const tag = element.tagName.toLowerCase();
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name === "href" && tag === "a") continue;
    if (name === "start" && tag === "ol") continue;
    if (name === "style") {
      const kept = keptStyle(attribute.value);
      if (kept) element.setAttribute("style", kept);
      else element.removeAttribute("style");
      continue;
    }
    element.removeAttribute(attribute.name);
  }
}

function renameTag(element: Element, tag: string): Element {
  const replacement = element.ownerDocument.createElement(tag);
  while (element.firstChild) replacement.appendChild(element.firstChild);
  element.replaceWith(replacement);
  return replacement;
}

/** 貼り付けられた HTML 文字列を、本文に持ち込める要素だけの HTML にする（ブラウザの DOMParser が要る）。 */
export function normalizePastedHtml(html: string): string {
  // DOMParser の文書は不活性（script は動かず、画像も読み込まれない）
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const element of Array.from(doc.body.querySelectorAll(DROP_WITH_CONTENT.join(",")))) element.remove();
  // コメント・処理命令（条件付きコメントなど）
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const comment of comments) comment.parentNode?.removeChild(comment);
  for (const element of Array.from(doc.body.querySelectorAll("*"))) {
    const target = HEADING_LEVEL[element.tagName.toLowerCase()];
    cleanAttributes(target ? renameTag(element, target) : element);
  }
  return doc.body.innerHTML;
}
