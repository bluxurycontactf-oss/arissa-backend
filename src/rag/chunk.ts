const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_OVERLAP = 100;

/** Splits text into overlapping chunks, breaking on paragraph/sentence boundaries when possible. */
export function chunkText(text: string, size = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!cleaned) return [];
  if (cleaned.length <= size) return [cleaned];

  const chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    let end = Math.min(start + size, cleaned.length);

    if (end < cleaned.length) {
      const breakPoint = cleaned.lastIndexOf("\n\n", end);
      const sentenceBreak = cleaned.lastIndexOf(". ", end);
      const candidate = Math.max(breakPoint, sentenceBreak);
      if (candidate > start + size / 2) {
        end = candidate + 1;
      }
    }

    const chunk = cleaned.slice(start, end).trim();
    if (chunk) chunks.push(chunk);

    if (end >= cleaned.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}
