/**
 * Metas de tempo e distância: marcos que se alcançam uma vez e o desafio do mês.
 *
 * Tudo derivado do histórico, sem estado próprio — o mesmo princípio da escada de
 * progressão: apagar um treino recalcula as conquistas, e não há como as duas coisas
 * divergirem.
 *
 * Distância numa bike de spinning é ESTIMADA. A maioria dos sensores (o XOSS ARENA
 * incluído) fica na pedivela e só mede cadência; não há roda. A estimativa é
 * pedaladas × uma "marcha virtual" — quantos metros uma pedalada valeria numa bike de rua.
 * Ela não enxerga a carga do botão de resistência, então serve para comparar você com
 * você mesmo, não com o ciclocomputador de ninguém. Toda tela que mostra o número diz isso.
 */

import * as Storage from './storage.js';

/**
 * Marchas virtuais, em metros por pedalada.
 *
 * Média = 5,5 m, o desenvolvimento de um 50×19 numa roda 700c: a 80 rpm dá ~26 km/h, a
 * velocidade que um ciclista amador sustenta no plano. Leve e pesada cobrem quem acha o
 * número otimista ou modesto demais para a carga que usa.
 */
export const VIRTUAL_GEARS = [
  { id: 'leve', label: 'Leve', metersPerRev: 4.5 },
  { id: 'media', label: 'Média', metersPerRev: 5.5 },
  { id: 'pesada', label: 'Pesada', metersPerRev: 6.5 },
];

export function metersPerRev(settings = Storage.getSettings()) {
  return (VIRTUAL_GEARS.find(g => g.id === settings.virtualGear) || VIRTUAL_GEARS[1]).metersPerRev;
}

/** Velocidade que a marcha implica a uma cadência — para o texto de ajuda do perfil. */
export function speedAt(rpm, mPerRev) {
  return Math.round((rpm * mPerRev * 60) / 1000);
}

/**
 * Distância de um treino: a do sensor de roda quando houve, senão a estimada.
 *
 * Treinos gravados antes da estimativa existir são estimados pela cadência média × duração.
 * É um pouco otimista (conta como pedalado o tempo sem cadência), aceitável para marcos.
 *
 * @returns {{m: number, estimated: boolean}}
 */
export function workoutDistance(w, mPerRev = metersPerRev()) {
  if ((w?.distanceM || 0) > 0) return { m: w.distanceM, estimated: false };
  if ((w?.estDistanceM || 0) > 0) return { m: w.estDistanceM, estimated: true };
  if ((w?.avgRPM || 0) > 0 && (w?.durationSeconds || 0) > 0) {
    return { m: w.avgRPM * (w.durationSeconds / 60) * mPerRev, estimated: true };
  }
  return { m: 0, estimated: false };
}

// ── Marcos ───────────────────────────────────────────────────────────────────

/** Treino mais longo, em minutos. */
export const RIDE_MINUTES_MARKS = [15, 20, 30, 45, 60, 75, 90, 120];
/** Maior distância num treino, em km. */
export const RIDE_KM_MARKS = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100];
/** Distância acumulada, em km. */
export const TOTAL_KM_MARKS = [25, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000];

/**
 * Uma trilha de marcos: o melhor valor, quais marcos já caíram (e em qual treino), e o
 * próximo com o quanto falta.
 */
function track(marks, valuesChrono, mode) {
  let current = 0;
  const achieved = [];
  for (const { value, w } of valuesChrono) {
    current = mode === 'sum' ? current + value : Math.max(current, value);
    for (const mark of marks) {
      if (current >= mark && !achieved.some(a => a.mark === mark)) {
        achieved.push({ mark, date: w.date, workoutId: w.id });
      }
    }
  }
  const next = marks.find(m => m > current) ?? null;
  const prev = [...marks].reverse().find(m => m <= current) ?? 0;
  return {
    value: current,
    achieved,
    next,
    // Progresso do degrau atual, não desde zero: sair de 45 para 60 min deve começar
    // vazio, ou a barra estaria sempre quase cheia e nunca diria nada.
    progress: next ? Math.max(0, Math.min(1, (current - prev) / (next - prev))) : 1,
  };
}

/**
 * @param {object[]} [workouts] treinos que contam, em qualquer ordem
 */
export function getMilestones(workouts, mPerRev = metersPerRev()) {
  const list = (workouts || Storage.getWorkouts().filter(Storage.countsAsTraining))
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const minutes = list.map(w => ({ value: (w.durationSeconds || 0) / 60, w }));
  const km = list.map(w => ({ value: workoutDistance(w, mPerRev).m / 1000, w }));

  return {
    longestRide: track(RIDE_MINUTES_MARKS, minutes, 'max'),
    longestDistance: track(RIDE_KM_MARKS, km, 'max'),
    totalDistance: track(TOTAL_KM_MARKS, km, 'sum'),
    anyEstimated: list.some(w => workoutDistance(w, mPerRev).estimated),
  };
}

/** Marcos que ESTE treino derrubou — para comemorar no resumo. */
export function milestonesReachedBy(workoutId, milestones) {
  const out = [];
  const pick = (t, label) => t.achieved
    .filter(a => a.workoutId === workoutId)
    .forEach(a => out.push(label(a.mark)));
  pick(milestones.longestRide, (m) => `Primeiro treino de ${m} min`);
  pick(milestones.longestDistance, (m) => `${m} km num só treino`);
  pick(milestones.totalDistance, (m) => `${m} km acumulados`);
  return out;
}

// ── Desafio do mês ───────────────────────────────────────────────────────────

const roundTo = (n, step) => Math.max(step, Math.round(n / step) * step);

/**
 * Meta de distância e de minutos para o mês corrente, calibrada no seu histórico.
 *
 * Com um mês anterior registrado: 10% acima dele — progressão pequena, para ser alcançável
 * todo mês e não só no primeiro. Sem ele: a meta semanal de treinos × o seu treino típico.
 * Nunca abaixo de 20 km / 60 min, para continuar sendo um desafio.
 */
export function getMonthlyChallenge(workouts, { now = Date.now(), weeklyGoal, mPerRev = metersPerRev() } = {}) {
  const list = workouts || Storage.getWorkouts().filter(Storage.countsAsTraining);
  const goal = weeklyGoal ?? Storage.getSettings().weeklyGoal ?? 3;

  const today = new Date(now);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const prevStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const nextStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const daysInMonth = Math.round((nextStart - monthStart) / 86_400_000);
  const dayOfMonth = today.getDate();

  const inRange = (w, a, b) => { const d = new Date(w.date); return d >= a && d < b; };
  const sum = (ws, f) => ws.reduce((s, w) => s + f(w), 0);
  const kmOf = (w) => workoutDistance(w, mPerRev).m / 1000;
  const minOf = (w) => (w.durationSeconds || 0) / 60;

  const thisMonth = list.filter(w => inRange(w, monthStart, nextStart));
  const prevMonth = list.filter(w => inRange(w, prevStart, monthStart));

  const recent = list.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
  const typical = (f, fallback) => {
    const v = recent.map(f).filter(x => x > 0).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : fallback;
  };

  // Sem mês anterior, o desafio conta a partir do primeiro treino deste mês: quem começa
  // no dia 20 não pode receber uma meta de mês inteiro, que já nasceria perdida.
  const firstDay = thisMonth.length
    ? Math.min(...thisMonth.map(w => new Date(w.date).getDate()))
    : dayOfMonth;
  const hasHistoryBase = prevMonth.length > 0;
  const startDay = hasHistoryBase ? 1 : firstDay;
  const activeDays = daysInMonth - startDay + 1;
  const sessionsPerMonth = Math.max(1, goal) * (activeDays / 7);

  const prevKm = sum(prevMonth, kmOf);
  const prevMin = sum(prevMonth, minOf);
  const targetKm = Math.max(20, roundTo(prevKm > 0 ? prevKm * 1.1 : sessionsPerMonth * typical(kmOf, 7), 5));
  const targetMin = Math.max(60, roundTo(prevMin > 0 ? prevMin * 1.1 : sessionsPerMonth * typical(minOf, 20), 30));

  const km = sum(thisMonth, kmOf);
  const min = sum(thisMonth, minOf);
  const expected = Math.max(0, dayOfMonth - startDay + 1) / activeDays;

  return {
    monthName: today.toLocaleDateString('pt-BR', { month: 'long' }),
    basedOnLastMonth: hasHistoryBase,
    daysLeft: daysInMonth - dayOfMonth,
    km: { value: km, target: targetKm, pct: Math.min(1, km / targetKm), onTrack: km / targetKm >= expected },
    minutes: { value: min, target: targetMin, pct: Math.min(1, min / targetMin), onTrack: min / targetMin >= expected },
    sessions: thisMonth.length,
  };
}
