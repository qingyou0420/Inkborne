/**
 * Find review evidence inside the current manuscript container.
 * Search stays in that container so the review drawer is never a hit.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface EvidenceMatch {
  readonly start: number;
  readonly length: number;
}

export interface LocateManuscriptEvidenceResult {
  readonly found: boolean;
  readonly repeated?: boolean;
}

const MIN_QUERY = 8;
const lastHit = new WeakMap<HTMLElement, { query: string; start: number }>();

export function evidenceQuery(evidence: string): string {
  return evidence.replace(/\s+/g, " ").trim();
}

export function findEvidenceInHaystack(haystack: string, evidence: string): EvidenceMatch | undefined {
  const full = evidenceQuery(evidence);
  if (!full) return undefined;
  const candidates = [full];
  if (full.length > 80) candidates.push(full.slice(0, 80).trim());
  if (full.length > 40) candidates.push(full.slice(0, 40).trim());
  for (const query of candidates) {
    const match = collapsedSearch(haystack, query);
    if (match) return match;
  }
  if (full.length > MIN_QUERY) {
    return collapsedSearch(haystack, full.slice(0, MIN_QUERY));
  }
  return undefined;
}

function collapsedSearch(haystack: string, needle: string): EvidenceMatch | undefined {
  const query = needle.replace(/\s+/g, " ").trim();
  if (!query) return undefined;
  const exact = haystack.indexOf(query);
  if (exact >= 0) return { start: exact, length: query.length };

  const map: number[] = [];
  let collapsed = "";
  let prevSpace = true;
  for (let index = 0; index < haystack.length; index += 1) {
    const char = haystack[index]!;
    const space = /\s/.test(char);
    if (space) {
      if (!prevSpace) {
        map.push(index);
        collapsed += " ";
        prevSpace = true;
      }
      continue;
    }
    map.push(index);
    collapsed += char;
    prevSpace = false;
  }
  const at = collapsed.indexOf(query);
  if (at < 0) return undefined;
  const start = map[at];
  const last = map[at + query.length - 1];
  if (start == null || last == null) return undefined;
  return { start, length: last - start + 1 };
}

export function locateManuscriptEvidence(container: HTMLElement, evidence: string): LocateManuscriptEvidenceResult {
  const query = evidenceQuery(evidence);
  if (!query) return { found: false };
  clearEvidenceHits(container);

  const textarea = container instanceof HTMLTextAreaElement
    ? container
    : container.querySelector("textarea");
  if (textarea instanceof HTMLTextAreaElement) {
    return locateInTextarea(container, textarea, query);
  }

  const collected = collectTextNodes(container);
  const match = findEvidenceInHaystack(collected.text, query);
  if (!match) return { found: false };

  const previous = lastHit.get(container);
  const repeated = previous?.query === query && previous.start === match.start;
  lastHit.set(container, { query, start: match.start });

  const range = rangeFromCollected(collected.nodes, match.start, match.length);
  if (range && typeof window !== "undefined") {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  const block = highlightRange(container, range);
  block?.scrollIntoView({ block: "center", inline: "nearest" });
  return { found: true, repeated };
}

function locateInTextarea(
  container: HTMLElement,
  textarea: HTMLTextAreaElement,
  query: string,
): LocateManuscriptEvidenceResult {
  const match = findEvidenceInHaystack(textarea.value, query);
  if (!match) return { found: false };
  const previous = lastHit.get(container);
  const repeated = previous?.query === query && previous.start === match.start;
  lastHit.set(container, { query, start: match.start });
  const end = match.start + match.length;
  textarea.focus();
  textarea.setSelectionRange(match.start, end);
  const ratio = textarea.value.length > 0 ? match.start / textarea.value.length : 0;
  textarea.scrollTop = Math.max(0, textarea.scrollHeight * ratio - textarea.clientHeight / 3);
  textarea.scrollIntoView({ block: "center", inline: "nearest" });
  textarea.classList.add("manuscript-evidence-hit");
  return { found: true, repeated };
}

function clearEvidenceHits(container: HTMLElement): void {
  container.classList.remove("manuscript-evidence-hit");
  container.querySelectorAll(".manuscript-evidence-hit").forEach((node) => {
    node.classList.remove("manuscript-evidence-hit");
  });
}

function collectTextNodes(container: HTMLElement): { text: string; nodes: Array<{ node: Text; start: number }> } {
  const nodes: Array<{ node: Text; start: number }> = [];
  let text = "";
  if (typeof document === "undefined") {
    return { text: container.textContent ?? "", nodes };
  }
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data) continue;
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  return { text, nodes };
}

function rangeFromCollected(
  nodes: ReadonlyArray<{ node: Text; start: number }>,
  start: number,
  length: number,
): Range | undefined {
  if (typeof document === "undefined" || nodes.length === 0) return undefined;
  const end = start + length;
  const startEntry = nodes.find((entry, index) => {
    const next = nodes[index + 1]?.start ?? Number.POSITIVE_INFINITY;
    return start >= entry.start && start < next;
  });
  const endEntry = [...nodes].reverse().find((entry) => end > entry.start);
  if (!startEntry || !endEntry) return undefined;
  const range = document.createRange();
  range.setStart(startEntry.node, Math.min(startEntry.node.data.length, start - startEntry.start));
  range.setEnd(endEntry.node, Math.min(endEntry.node.data.length, Math.max(0, end - endEntry.start)));
  return range;
}

function highlightRange(container: HTMLElement, range: Range | undefined): HTMLElement | undefined {
  const node = range?.startContainer;
  const element = node instanceof HTMLElement ? node : node?.parentElement;
  const block = element?.closest("p, li, h1, h2, h3, h4, blockquote, pre, td, div") ?? element;
  if (block instanceof HTMLElement && container.contains(block)) {
    block.classList.add("manuscript-evidence-hit");
    return block;
  }
  container.classList.add("manuscript-evidence-hit");
  return container;
}
