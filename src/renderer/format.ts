// Text helpers: relative times, branch titles, and the PR-body markdown.

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 2592000) return `${Math.floor(d / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Turn a branch slug into a readable title: "stefan/update-hero" → "Update Hero".
export function prettyBranch(name: string): string {
  return (name.split("/").pop() || name).replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const plural = (n: number, s = "s") => (n !== 1 ? s : "");

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// One block of rendered markdown. `html` is built from escaped text only.
export type MdBlock = { tag: "h2" | "p" | "ul"; html: string } | { tag: "hr" };

// The small markdown subset PR descriptions use: headings, rules, (nested)
// bullet lists, paragraphs, and inline code / bold / italic. Escapes first, so
// raw HTML in the source always shows as text.
export function markdownBlocks(md: string | null | undefined): MdBlock[] {
  const blocks: MdBlock[] = [];
  let list: string | null = null;
  const closeList = () => { if (list !== null) { blocks.push({ tag: "ul", html: list }); list = null; } };
  const inline = (s: string) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/_([^_]+)_/g, "<em>$1</em>");
  for (const raw of esc(md || "").split("\n")) {
    const line = raw.trimEnd();
    if (/^#{1,3}\s+/.test(line)) { closeList(); blocks.push({ tag: "h2", html: inline(line.replace(/^#{1,3}\s+/, "")) }); }
    else if (/^---\s*$/.test(line)) { closeList(); blocks.push({ tag: "hr" }); }
    else if (/^\s*[-*]\s+/.test(line)) {
      const indent = line.match(/^\s*/)![0].length;
      list = (list ?? "") + `<li${indent >= 2 ? ' style="margin-left:14px"' : ""}>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`;
    }
    else if (line === "") closeList();
    else { closeList(); blocks.push({ tag: "p", html: inline(line) }); }
  }
  closeList();
  return blocks;
}
