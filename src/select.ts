/** Role-weighted axis mix; the "capability" the selector actually trades against cost. */
export function capabilityFit(scores: AxisScores, weights: AxisWeights): number {
  // Weighted generalized mean with p = -2: aggressively penalize low axis
  // scores, so a model with one weak axis (e.g. Ling-3.1-Flash: strong
  // reasoning, weak code/general) does not clear the minFit gate off its
  // strengths alone.
  const p = -2;
  let numerator = 0;
  let activeWeight = 0;
  for (const axis of CAPABILITY_AXES) {
    const w = weights[axis];
    const x = scores[axis];
    if (w > 0 && x > 0) {
      numerator += w * Math.pow(x, p);
      activeWeight += w;
    } else if (w > 0) {
      // A zero measured axis makes the mean zero — unconditional rejection.
      return 0;
    }
  }
  return Math.pow(numerator / activeWeight, 1 / p);
}