/** SPDX-License-Identifier: AGPL-3.0-only */
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";

const plugins = { cjk };
const fieldNames: Record<string, string> = { title: "书名", genre: "题材", targetChapters: "预计章节", chapterWordCount: "每章字数", language: "语言", premise: "故事命题", protagonist: "主角" };

export function ManuscriptView({ body, className = "", parseFrontmatter = false }: {
  readonly body: string;
  readonly className?: string;
  readonly parseFrontmatter?: boolean;
}) {
  const match = parseFrontmatter ? /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body) : null;
  const metadata = match ? match[1].split(/\r?\n/).flatMap((line) => {
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!pair || !fieldNames[pair[1]]) return [];
    let value = pair[2];
    try { value = String(JSON.parse(value)); } catch { value = value.replace(/^['"]|['"]$/g, ""); }
    return [{ key: pair[1], name: fieldNames[pair[1]], value }];
  }) : [];
  return <div className={`ink-manuscript ${className}`}>
    {metadata.length > 0 ? <dl className="ink-manuscript-meta">{metadata.map((field) => <div key={field.key}><dt>{field.name}</dt><dd>{field.value}</dd></div>)}</dl> : null}
    <Streamdown plugins={plugins} mode="static">{match ? body.slice(match[0].length) : body}</Streamdown>
  </div>;
}
