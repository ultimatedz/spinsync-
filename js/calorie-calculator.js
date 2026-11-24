export class CalorieCalculator {
  /**
   * @param {string} sex    'M' | 'F'
   * @param {number} weight kg
   * @param {number} age    anos
   * @param {number} [height] cm — opcional; sem ela cai na aproximação antiga.
   */
  constructor(sex, weight, age, height) {
    this.sex = sex;
    this.weight = weight;
    this.age = age;
    this.height = height;

    this.bmrPerMin = computeBmrPerMin(sex, weight, age, height);
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

/**
 * Gasto basal de um intervalo, em kcal — o que somado às calorias ATIVAS dá o total.
 *
 * Existe para o Health Connect: TotalCaloriesBurned é ativo + basal, e gravar ali o valor
 * ativo (como era feito) subnotificava o total e deixava os dois registros iguais.
 */
export function restingKcal(profile, minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  const p = profile || {};
  return computeBmrPerMin(p.sex, p.weight, p.age, p.height) * minutes;
}

/**
 * Basal metabolic rate in kcal/min, subtracted from the Keytel total so what is reported
 * is *active* calories — the same convention Samsung Health, Apple Watch and Garmin use.
 *
 * With a height, this is Mifflin-St Jeor, the formula the code always wanted:
 *   Homens:   BMR = 10·peso + 6.25·altura − 5·idade + 5
 *   Mulheres: BMR = 10·peso + 6.25·altura − 5·idade − 161
 *
 * Without one it falls back to the old flat 1.0 / 0.9 kcal/min. That constant is a
 * population average: for a 55 kg woman it overstates the resting burn by roughly a
 * third, and for a 100 kg man it understates it by about as much — which lands straight
 * in the active-calorie figure, since it is subtracted from it.
 */
function computeBmrPerMin(sex, weight, age, height) {
  const usable = Number.isFinite(height) && height >= 100 && height <= 250
    && Number.isFinite(weight) && Number.isFinite(age);
  if (!usable) return sex === 'M' ? 1.0 : 0.9;

  const bmrPerDay = 10 * weight + 6.25 * height - 5 * age + (sex === 'M' ? 5 : -161);
  return bmrPerDay / (24 * 60);
}
