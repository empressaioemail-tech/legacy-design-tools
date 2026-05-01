/**
 * Word-level diff between two strings.
 *
 * Used by the briefing prior-narrative panel to annotate, per A–G
 * section, what the current narrative *removed* and *added* relative
 * to the snapshot the briefing was holding before the most recent
 * regeneration. Computed inline rather than pulled from a `diff`
 * package to avoid adding a runtime dependency for one consumer.
 *
 * Algorithm: standard backwards LCS DP over whitespace-tokenised
 * inputs (whitespace runs are kept as their own tokens so the
 * reconstructed body preserves the original spacing exactly).
 * Output is a flat sequence of ops the renderer walks once: tokens
 * that survive into the current narrative read as `equal`, tokens
 * present only in the prior body read as `removed` (rendered with
 * strikethrough so the auditor sees what was dropped), and tokens
 * present only in the current body read as `added` (rendered with
 * underline so the auditor sees what was inserted in their place).
 *
 * Inputs are bounded by section length (a few KB at most), so the
 * O(m·n) memory cost is negligible for the realistic worst case.
 */
export type WordDiffOp = {
  type: "equal" | "added" | "removed";
  text: string;
};

export function diffWords(prior: string, current: string): WordDiffOp[] {
  // Split on whitespace runs while *preserving* them as tokens so
  // joining the equal/removed/added pieces back together yields a
  // body whose whitespace matches the original. `String.split` with
  // a captured group keeps the separators interleaved with the
  // word tokens.
  const a = prior.split(/(\s+)/).filter((tok) => tok.length > 0);
  const b = current.split(/(\s+)/).filter((tok) => tok.length > 0);
  const m = a.length;
  const n = b.length;
  // Backwards LCS so the reconstruction below can walk forwards.
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[i]![j] = (dp[i + 1]![j + 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
      }
    }
  }
  const out: WordDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "equal", text: a[i]! });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      out.push({ type: "removed", text: a[i]! });
      i += 1;
    } else {
      out.push({ type: "added", text: b[j]! });
      j += 1;
    }
  }
  while (i < m) {
    out.push({ type: "removed", text: a[i]! });
    i += 1;
  }
  while (j < n) {
    out.push({ type: "added", text: b[j]! });
    j += 1;
  }
  return out;
}
