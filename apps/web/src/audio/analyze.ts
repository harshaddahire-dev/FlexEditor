/**
 * Sample indices where a signal switches on: the first sample whose magnitude reaches `threshold` after at least
 * `quietSamples` of silence. Used by the A/V sync proofs and QA to locate beeps in a rendered mix.
 */
export function detectOnsets(x: Float32Array, threshold: number, quietSamples: number): number[] {
  const out: number[] = [];
  let quiet = quietSamples; // treat the start as quiet
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]!) >= threshold) {
      if (quiet >= quietSamples) out.push(i);
      quiet = 0;
    } else quiet++;
  }
  return out;
}

/** Peak level of a block in dBFS (-Infinity for digital silence). */
export function peakDb(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(p);
}
