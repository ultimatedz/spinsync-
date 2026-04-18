export class CalorieCalculator {
  constructor(sex, weight, age) {
    this.sex = sex;
    this.weight = weight;
    this.age = age;
  }

  /**
   * Calcula calorias queimadas baseado em FC média e duração.
   * Fórmula Keytel et al. (2005) — HR-based energy expenditure.
   * @param {number} avgHR - FC média (bpm)
   * @param {number} durationMinutes - Duração em minutos
   * @returns {number} Calorias (kcal)
   */
  calculate(avgHR, durationMinutes) {
    if (avgHR <= 0 || durationMinutes <= 0) return 0;

    let calories;
    if (this.sex === 'M') {
      calories = durationMinutes * (
        0.6309 * avgHR +
        0.1988 * this.weight +
        0.2017 * this.age -
        55.0969
      ) / 4.184;
    } else {
      calories = durationMinutes * (
        0.4472 * avgHR -
        0.1263 * this.weight +
        0.074 * this.age -
        20.4022
      ) / 4.184;
    }

    return Math.max(0, Math.round(calories));
  }

  /**
   * Calcula calorias incrementais para um intervalo curto (ex: 1 segundo).
   * @param {number} currentHR - FC atual (bpm)
   * @param {number} intervalSeconds - Intervalo em segundos
   * @returns {number} Calorias incrementais
   */
  calculateIncremental(currentHR, intervalSeconds) {
    if (currentHR <= 0) return 0;
    const durationMinutes = intervalSeconds / 60;
    return this.calculate(currentHR, durationMinutes);
  }
}
