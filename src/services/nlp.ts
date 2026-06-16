const STOPWORDS = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "a", "à",
  "au", "aux", "ce", "ces", "cet", "cette", "il", "elle", "ils", "elles",
  "je", "tu", "on", "nous", "vous", "que", "qui", "quoi", "dont", "est",
  "es", "suis", "sont", "être", "avoir", "ai", "as", "avez", "avons", "ont",
  "pour", "par", "avec", "sans", "sur", "dans", "en", "ne", "pas", "plus",
  "comment", "votre", "vos", "mon", "ma", "mes", "son", "sa", "ses", "se",
  "j", "l", "d", "c", "s", "n", "y", "si", "mais", "donc", "or", "ni", "car",
]);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** Jaccard similarity between the keyword sets of two strings, 0-1. */
export function similarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function extractKeywords(text: string): string[] {
  return Array.from(new Set(tokenize(text)));
}
