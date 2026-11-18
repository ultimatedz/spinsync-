/**
 * Single source of truth for the numbers every other module derives from.
 *
 * Maximum heart rate used to be computed as `220 - age` in two places
 * (zone-calculator.js and progression.js, with different fallbacks), and the resting
 * heart rate the profile form collects was stored, passed around and never actually
 * read. Both are fixed here.
 */

/**
 * Age-predicted maximum heart rate, Tanaka et al. (2001).
 *
 * `220 - age` is the textbook version and the one this app used to ship. It carries a
 * standard deviation of roughly 10-12 bpm and is known to overestimate for people under
 * ~40 and underestimate above it. Tanaka has a tighter spread across the adult range and
 * costs exactly one more multiplication.
 *
 * It is still an estimate. A measured value always wins — see [getMaxHR].
 */
export function predictMaxHR(age) {
  if (!Number.isFinite(age) || age <= 0) return 190;
  return Math.round(208 - 0.7 * age);
}

/**
 * The max HR to actually use: whatever the rider measured, else the prediction.
 *
 * Every zone boundary, the time-in-zone breakdown and the progression engine's
 * "did you overcook this" check hang off this one number, which is exactly why it is
 * worth letting people override it.
 */
export function getMaxHR(profile) {
  const measured = profile?.maxHR;
  if (Number.isFinite(measured) && measured >= 120 && measured <= 230) return measured;
  return predictMaxHR(profile?.age);
}

export function getRestingHR(profile) {
  const rhr = profile?.restingHR;
  return Number.isFinite(rhr) && rhr >= 30 && rhr <= 120 ? rhr : 60;
}

/** True when the profile carries enough to use heart-rate reserve rather than %max. */
export function usesReserve(profile) {
  return Number.isFinite(profile?.restingHR) && getMaxHR(profile) > getRestingHR(profile) + 40;
}
