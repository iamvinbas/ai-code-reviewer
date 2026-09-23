/** Conservative token estimate: real tokenizers average ~2.9 chars/token on numbered code diffs. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
