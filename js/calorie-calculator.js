export class CalorieCalculator {
  constructor(sex, weight, age) {
    this.sex = sex;
    this.weight = weight;
    this.age = age;

    // Pre-calculate BMR (Mifflin-St Jeor) in kcal/min for resting subtraction
    // Men:   BMR = 10 * weight + 6.25 * height - 5 * age + 5
    // Women: BMR = 10 * weight + 6.25 * height - 5 * age - 161
    // Since we don't have height, use Katch-McArdle approximation:
    // ~1.0 kcal/min for men, ~0.9 kcal/min for women (average resting rate)
    this.bmrPerMin = sex === 'M' ? 1.0 : 0.9;
  }

  /**
   * Calcula calorias ATIVAS queimadas baseado em FC e duração.
   * Fórmula Keytel et al. (2005) — HR-based energy expenditure,
   * com subtração de metabolismo basal para reportar apenas calorias ativas
   * (consistente com Samsung Health, Apple Watch, Garmin, etc.)
   * 
   * @param {number} avgHR - FC média (bpm)
   * @param {number} durationMinutes - Duração em minutos
   * @returns {number} Calorias ativas (kcal)
   */
  calculate(avgHR, durationMinutes) {
    if (avgHR <= 0 || durationMinutes <= 0) return 0;

    let totalCalories;
    if (this.sex === 'M') {
      // Keytel formula (kJ/min → kcal/min)
      totalCalories = durationMinutes * (
        0.6309 * avgHR +
        0.1988 * this.weight +
        0.2017 * this.age -
        55.0969
      ) / 4.184;
    } else {
      totalCalories = durationMinutes * (
        0.4472 * avgHR -
        0.1263 * this.weight +
        0.074 * this.age -
        20.4022
      ) / 4.184;
    }

    // Subtract resting metabolic rate to get ACTIVE calories only
    // This aligns with how Samsung Health, Apple Watch, and Garmin report
    const restingCalories = this.bmrPerMin * durationMinutes;
    const activeCalories = totalCalories - restingCalories;

    return Math.max(0, activeCalories);
  }

  /**
   * Calcula calorias incrementais para um intervalo curto (ex: 1 segundo).
   * @param {number} currentHR - FC atual (bpm)
   * @param {number} intervalSeconds - Intervalo em segundos
   * @returns {number} Calorias ativas incrementais
   */
  calculateIncremental(currentHR, intervalSeconds) {
    if (currentHR <= 0) return 0;
    const durationMinutes = intervalSeconds / 60;
    return this.calculate(currentHR, durationMinutes);
  }
}
