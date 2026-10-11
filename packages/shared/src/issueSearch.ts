/** Reads menu-equivalent qualifiers; the original query always goes to GitHub unchanged. */
export function parseIssueSearch(query: string) {
  let state: "open" | "closed" | undefined;
  let author: string | undefined;
  const labels: string[] = [];
  for (const token of query.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) ?? []) {
    const match = /^(is|state|author|label):(.+)$/i.exec(token);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const raw = match[2]!;
    const value =
      raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, "$1") : raw;
    if ((key === "is" || key === "state") && (value === "open" || value === "closed"))
      state = value;
    if (key === "author") author = value;
    if (key === "label") labels.push(value);
  }
  return { state, author, labels };
}
