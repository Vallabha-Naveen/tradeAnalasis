/**
 * Confidence scoring utility for analyzer results.
 *
 * Provides helper functions to validate, combine, and threshold
 * confidence scores across multiple detection methods.
 */

/** Minimum confidence to consider a detection valid */
export const MIN_CONFIDENCE = 50;

/** Confidence threshold below which a trade needs human review */
export const REVIEW_THRESHOLD = 70;

/**
 * Result from a single detection method.
 */
export interface DetectionScore<T = string> {
  value: T | null;
  confidence: number;
  method: string;
}

/**
 * Clamp a confidence value to the 0–100 range.
 */
export function clampConfidence(confidence: number): number {
  return Math.max(0, Math.min(100, Math.round(confidence)));
}

/**
 * Combine multiple detection scores for the same field.
 *
 * Strategy: weighted average favoring the highest-confidence result.
 * If all methods agree, confidence is boosted.
 * If methods disagree, confidence is penalized.
 *
 * @param scores - Array of detection scores for the same field
 * @returns The best value with combined confidence, or null if no valid scores
 */
export function combineScores<T extends string>(
  scores: DetectionScore<T>[],
): DetectionScore<T> | null {
  if (scores.length === 0) return null;

  // Filter out low-confidence results
  const valid = scores.filter((s) => s.confidence >= MIN_CONFIDENCE);
  if (valid.length === 0) return null;

  // Single valid result — return as-is
  if (valid.length === 1) {
    return valid[0]!;
  }

  // Check if all methods agree on the same value
  const values = new Set(valid.map((s) => s.value));
  const allAgree = values.size === 1;

  if (allAgree) {
    // Boost confidence when multiple methods agree
    const avgConfidence =
      valid.reduce((sum, s) => sum + s.confidence, 0) / valid.length;
    const boost = Math.min(10, valid.length * 3);
    return {
      value: valid[0]!.value,
      confidence: clampConfidence(avgConfidence + boost),
      method: valid.map((s) => s.method).join('+'),
    };
  }

  // Disagreement — pick the highest confidence but penalize
  const sorted = [...valid].sort((a, b) => b.confidence - a.confidence);
  const best = sorted[0]!;
  const penalty = (valid.length - 1) * 10;

  return {
    value: best.value,
    confidence: clampConfidence(best.confidence - penalty),
    method: best.method,
  };
}

/**
 * Determine if a confidence score requires human review.
 */
export function needsReview(confidence: number): boolean {
  return confidence < REVIEW_THRESHOLD;
}