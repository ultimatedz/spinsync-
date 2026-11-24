/**
 * Treino do dia: o que fazer hoje, com a dose certa, e por quê.
 *
 * Regras explícitas em vez de um modelo. Com poucos treinos no histórico (o caso de quase
 * todo mundo no começo) um modelo estatístico não teria o que aprender, e cada sugestão
 * precisa vir com a razão por escrito — quem pedala decide se confia nela.
 *
 * O princípio é o da distribuição polarizada: a maior parte do volume em Z2 (o que mais
 * constrói fôlego), um ou dois dias de qualidade por semana, e nunca dois dias fortes
 * colados. Os dias de qualidade seguem a escada de progressão, que já é calibrada; os
 * dias de base usam o catálogo de fôlego com a duração ajustada ao que você tem feito.
 */

import * as Storage from './storage.js';
import * as Plans from './training-plans.js';
import * as Progression from './progression.js';
import { computeTrainingLoad } from './analytics.js';
import { predictMaxHR } from './physiology.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 1.78 → "1,78": o texto é lido em português. */
const ratioLabel = (r) => String(r).replace('.', ',');

/** Depois de um treino forte, quanto tempo pedir só base ou recuperação. */
const HARD_RECOVERY_HOURS = 48;
/** Acima disto, a semana já teve qualidade suficiente. */
const MAX_HARD_PER_WEEK = 2;
/** Parado por isto ou mais, a volta começa em base, um pouco mais curta. */
const COMEBACK_DAYS = 6;
/** Progressão de volume entre sessões de base. Pequena de propósito. */
const DOSE_STEP = 1.1;
const MIN_TARGET_MIN = 15;
const MAX_TARGET_MIN = 60;

const DIFFICULTY_RANK = { 'Iniciante': 0, 'Iniciante+': 0.5, 'Intermediário': 1, 'Avançado': 2 };

// ── Leitura do histórico ─────────────────────────────────────────────────────

/**
 * Se um treino gravado foi forte.
 *
 * Por tempo em zona alta quando há FC, por esforço percebido quando o usuário informou, e
 * pelo plano quando não há nenhum dos dois. Qualquer um dos três basta.
 */
export function workoutIsHard(w) {
  const z = w.zoneTime || {};
  if ((z[5] || 0) >= 60 || (z[4] || 0) + (z[5] || 0) >= 300) return true;
  if ((w.rpe || 0) >= 7) return true;
  if (w.planId) {
    const plan = Plans.getAllPlans().find(p => p.id === w.planId);
    if (plan && Plans.getPlanIntensity(plan).hard && (w.durationSeconds || 0) >= 600) return true;
  }
  return false;
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nível pela posição na escada: o único lugar onde ele é medido, e não declarado. */
function levelFromLadder(state) {
  if (state.graduated || state.currentIndex >= 8) return { rank: 2, name: 'Avançado' };
  if (state.currentIndex >= 4) return { rank: 1, name: 'Intermediário' };
  return { rank: 0, name: 'Iniciante' };
}

/**
 * Tudo que o recomendador sabe sobre você, num objeto só — e testável sem storage.
 *
 * @param {object} [opts]
 * @param {object[]} [opts.workouts] treinos que contam (Storage.countsAsTraining)
 * @param {number} [opts.now]
 */
export function getAthleteContext({ workouts, now = Date.now(), profile } = {}) {
  const list = (workouts || Storage.getWorkouts().filter(Storage.countsAsTraining))
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const ageOf = (w) => (now - new Date(w.date).getTime());
  const last = list[0] || null;
  const lastHard = list.find(workoutIsHard) || null;
  const last7 = list.filter(w => ageOf(w) < 7 * DAY_MS);

  const recentMinutes = list.slice(0, 5).map(w => (w.durationSeconds || 0) / 60);
  const ladder = Progression.getLadderState(profile || Storage.getProfile());

  return {
    now,
    sessions: list.length,
    last,
    daysSinceLast: last ? ageOf(last) / DAY_MS : Infinity,
    lastHard,
    hoursSinceHard: lastHard ? ageOf(lastHard) / 3_600_000 : Infinity,
    sessionsLast7: last7.length,
    hardLast7: last7.filter(workoutIsHard).length,
    typicalMin: median(recentMinutes),
    load: computeTrainingLoad(list, now),
    ladder,
    level: levelFromLadder(ladder),
  };
}

// ── Dose ─────────────────────────────────────────────────────────────────────

/** Só dá para esticar ou encurtar sem desfigurar um treino contínuo. */
function isScalable(plan) {
  if (Progression.isLadderPlan(plan.id)) return false; // a escada tem durações calibradas
  const middle = plan.phases.slice(1, -1);
  return middle.length > 0 && middle.every(p => p.zone <= 2);
}

/**
 * O plano com o miolo esticado ou encurtado para durar ~targetMin.
 *
 * Aquecimento e volta à calma ficam intactos: são eles que tornam o treino seguro, e são
 * curtos demais para valer a pena mexer. Arredonda em minutos cheios, para o nome
 * ("Base Aeróbica 23") e a duração mostrada baterem.
 *
 * @returns {object} cópia do plano; `personalized` descreve o ajuste quando houve um.
 */
export function scalePlan(plan, targetMin) {
  if (!plan || !isScalable(plan) || !Number.isFinite(targetMin)) return plan;

  const phases = plan.phases;
  const fixed = phases[0].duration + phases[phases.length - 1].duration;
  const middle = phases.slice(1, -1);
  const middleSec = middle.reduce((s, p) => s + p.duration, 0);
  const factor = Math.min(1.6, Math.max(0.5, (targetMin * 60 - fixed) / middleSec));
  if (Math.abs(factor - 1) < 0.05) return plan;

  const scaled = [
    phases[0],
    ...middle.map(p => ({ ...p, duration: Math.max(60, Math.round((p.duration * factor) / 60) * 60) })),
    phases[phases.length - 1],
  ];
  const fromSec = Plans.getPlanDuration(plan);
  const toSec = scaled.reduce((s, p) => s + p.duration, 0);
  // "Base Aeróbica 30" encurtado para 20 min não pode continuar se chamando 30.
  const name = /\s\d+$/.test(plan.name)
    ? plan.name.replace(/\s\d+$/, ` ${Math.round(toSec / 60)}`)
    : plan.name;
  return { ...plan, name, phases: scaled, personalized: { fromSec, toSec } };
}

/** Quanto tempo o próximo treino de base deve ter, dado o seu histórico. */
export function targetMinutes(ctx, kind) {
  if (!ctx.typicalMin) return 20;
  const factor = kind === 'retomada' ? 0.8 : kind === 'recuperacao' ? 0.7 : DOSE_STEP;
  return Math.round(Math.min(MAX_TARGET_MIN, Math.max(MIN_TARGET_MIN, ctx.typicalMin * factor)));
}

// ── Prontidão ────────────────────────────────────────────────────────────────

/**
 * Semáforo de prontidão a partir do que o relógio mediu à noite e da carga recente.
 *
 * Mesmos limiares do card de prontidão da home; agora num lugar só, para o card e a
 * recomendação não discordarem.
 */
export function readinessFlags(recovery, load) {
  const reasons = [];
  let flags = 0;
  if (recovery) {
    const hrvDrop = recovery.hrv && recovery.hrvBaseline
      ? (recovery.hrvBaseline - recovery.hrv) / recovery.hrvBaseline : 0;
    const rhrRise = recovery.restingHR && recovery.restingHRBaseline
      ? recovery.restingHR - recovery.restingHRBaseline : 0;
    if (hrvDrop > 0.2) flags += 2; else if (hrvDrop > 0.1) flags += 1;
    if (rhrRise >= 5) flags += 2; else if (rhrRise >= 3) flags += 1;
    if (recovery.sleepHours !== null && recovery.sleepHours < 6) flags += 1;
    if (hrvDrop > 0.1) reasons.push(`variabilidade ${Math.round(hrvDrop * 100)}% abaixo da sua média`);
    if (rhrRise >= 3) reasons.push(`FC de repouso ${rhrRise} bpm acima do normal`);
    if (recovery.sleepHours !== null && recovery.sleepHours < 6) reasons.push(`${recovery.sleepHours} h de sono`);
  }
  if (load?.ratio >= 1.5) {
    flags += 1;
    reasons.push(`carga dos últimos 7 dias ${ratioLabel(load.ratio)}× a média`);
  }
  const level = flags >= 3 ? 'red' : flags >= 1 ? 'yellow' : 'green';
  return { level, flags, reasons };
}

// ── Recomendação ─────────────────────────────────────────────────────────────

/** "hoje", "ontem", "há N dias" — por dia de calendário, não por blocos de 24 h. */
function daysAgoLabel(date, now) {
  const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(now) - day(date)) / DAY_MS);
  if (days <= 0) return 'hoje';
  return days === 1 ? 'ontem' : `há ${days} dias`;
}

/** O plano de base (Z2 contínuo) do nível, esticado para a dose. */
function baseSession(ctx, kind) {
  const target = targetMinutes(ctx, kind);
  const candidates = Plans.getPrebuiltPlans().filter(p =>
    p.category === 'folego' && isScalable(p)
    && (DIFFICULTY_RANK[p.difficulty] ?? 0) <= ctx.level.rank + 0.5);
  // O mais próximo da dose antes de escalar: menos deformação.
  const plan = candidates.reduce((best, p) =>
    !best || Math.abs(Plans.getPlanDuration(p) / 60 - target) < Math.abs(Plans.getPlanDuration(best) / 60 - target)
      ? p : best, null);
  return plan ? scalePlan(plan, target) : null;
}

function recoverySession(ctx) {
  const plan = Plans.getPrebuiltPlans().find(p => p.id === 'recuperacao_ativa');
  return plan ? scalePlan(plan, Math.min(30, targetMinutes(ctx, 'recuperacao'))) : null;
}

/**
 * O treino de hoje.
 *
 * @param {object} ctx de getAthleteContext()
 * @param {object} [readiness] de readinessFlags(); ausente fora do app nativo
 * @returns {{kind: string, plan: object, title: string, reasons: string[]}}
 */
export function recommend(ctx, readiness = null) {
  const reasons = [];
  const ladderStep = ctx.ladder.current?.plan || null;
  const doseNote = (plan) => {
    if (!plan?.personalized) return;
    const to = Math.round(plan.personalized.toSec / 60);
    const typical = Math.round(ctx.typicalMin);
    reasons.push(`Duração ajustada para ${to} min: seus últimos treinos tiveram cerca de ${typical} min.`);
  };

  // Sem histórico: o primeiro degrau, que existe para isto.
  if (ctx.sessions === 0) {
    const plan = ladderStep || baseSession(ctx, 'base');
    reasons.push('Primeiro treino registrado: comece pela base para o app conhecer sua resposta.');
    return { kind: 'inicio', plan, title: 'Para começar', reasons };
  }

  if (readiness?.level === 'red') {
    const plan = recoverySession(ctx);
    reasons.push(`Recuperação incompleta: ${readiness.reasons.join(', ')}.`);
    doseNote(plan);
    return { kind: 'recuperacao', plan, title: 'Recuperação', reasons };
  }

  if (ctx.load?.ratio >= 1.5) {
    const plan = recoverySession(ctx);
    reasons.push(`Seus últimos 7 dias tiveram ${ratioLabel(ctx.load.ratio)}× a carga média. Hoje, só soltar as pernas.`);
    doseNote(plan);
    return { kind: 'recuperacao', plan, title: 'Recuperação', reasons };
  }

  if (ctx.daysSinceLast >= COMEBACK_DAYS) {
    const plan = baseSession(ctx, 'retomada');
    reasons.push(`${Math.floor(ctx.daysSinceLast)} dias sem treinar: retome com base em Z2, um pouco mais curto.`);
    doseNote(plan);
    return { kind: 'retomada', plan, title: 'Retomada', reasons };
  }

  if (ctx.hoursSinceHard < HARD_RECOVERY_HOURS) {
    const plan = baseSession(ctx, 'base');
    const name = ctx.lastHard.planName ? ` (${ctx.lastHard.planName})` : '';
    reasons.push(`Treino forte ${daysAgoLabel(ctx.lastHard.date, ctx.now)}${name}. Hoje é dia de base: Z2 contínuo, que constrói fôlego sem somar cansaço.`);
    doseNote(plan);
    return { kind: 'base', plan, title: 'Base aeróbica', reasons };
  }

  if (ctx.hardLast7 >= MAX_HARD_PER_WEEK) {
    const plan = baseSession(ctx, 'base');
    reasons.push(`Você já fez ${ctx.hardLast7} treinos fortes nos últimos 7 dias. O resto da semana rende mais em Z2.`);
    doseNote(plan);
    return { kind: 'base', plan, title: 'Base aeróbica', reasons };
  }

  // Dia de qualidade: o próximo degrau da escada, que é a progressão calibrada.
  if (ladderStep) {
    if (readiness?.level === 'yellow') {
      reasons.push(`Sinais de recuperação parcial (${readiness.reasons.join(', ')}): faça, mas sem forçar o topo das zonas.`);
    }
    const since = Number.isFinite(ctx.hoursSinceHard)
      ? `Último treino forte ${daysAgoLabel(ctx.lastHard.date, ctx.now)}`
      : 'Nenhum treino forte recente';
    reasons.push(`${since}: dia bom para avançar. Este é o seu passo ${ctx.ladder.currentIndex + 1} de ${ctx.ladder.totalSteps} na escada.`);
    // "Dia de qualidade" só quando o degrau é de fato forte; os primeiros são leves.
    const title = Plans.getPlanIntensity(ladderStep).hard ? 'Dia de qualidade' : 'Próximo passo';
    return { kind: 'qualidade', plan: ladderStep, title, reasons };
  }

  // Escada concluída: qualidade pelo catálogo de fôlego do nível mais alto.
  const plan = Plans.getPrebuiltPlans().find(p => p.id === 'folego_4x4');
  reasons.push('Escada concluída. Para continuar evoluindo o fôlego, intervalos longos em Z4.');
  return { kind: 'qualidade', plan, title: 'Dia de qualidade', reasons };
}

/**
 * Sugere a FC máxima observada quando ela passa da estimada por idade.
 *
 * Só sugere, nunca troca sozinho: um pico de 1 s causado por interferência no sensor
 * deslocaria todas as zonas. Exige um treino de 10+ min e não mexe em valor medido.
 */
export function maxHRSuggestion(profile, workouts) {
  if (!profile || Number.isFinite(profile.maxHR)) return null;
  const estimate = predictMaxHR(profile.age);
  let best = null;
  for (const w of workouts || []) {
    if ((w.durationSeconds || 0) < 600) continue;
    const hr = Number(w.maxBPM) || 0;
    if (hr > 230) continue;
    if (!best || hr > best.hr) best = { hr, date: w.date };
  }
  if (!best || best.hr < estimate + 3) return null;
  return { observed: best.hr, estimate, date: best.date };
}
