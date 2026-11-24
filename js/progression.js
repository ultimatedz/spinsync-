/**
 * Progression engine — the "coach" that decides when to raise the bar.
 *
 * Reads finished guided sessions out of storage and judges each one against what the
 * plan actually prescribed (heart-rate zone per phase, cadence window per phase, total
 * duration). No extra state is persisted: the ladder position is always derived from
 * the workout history, so it can never drift out of sync with it.
 */

import * as Storage from './storage.js';
import * as Plans from './training-plans.js';
import { zoneCalcFromSummary } from './zone-calculator.js';

/**
 * The ladder. Ordered by difficulty, then by how demanding the plan is inside its level.
 * Custom plans are deliberately outside it — they have no calibrated place.
 */
export const LADDER = [
  'primeiro_pedal',          // Iniciante · adaptação
  'queima_suave',            // Iniciante · base aeróbica
  'intervalado_leve',        // Iniciante · primeiros intervalos
  'queima_progressiva',      // Iniciante+ · progressão contínua
  'resistencia_progressiva', // Intermediário · endurance
  'subida_simulada',         // Intermediário · força
  'piramide_potencia',       // Intermediário · potência
  'tabata_spinning',         // Intermediário · HIIT
  'sprint_recover',          // Avançado · velocidade
  'montanha_russa',          // Avançado · completo
  'resistencia_extrema',     // Avançado · endurance máx
  'the_finisher',            // Avançado · potência máx
];

// Score thresholds
const SCORE_ADVANCE = 78;      // good enough to count as a qualifying session
const SCORE_STANDOUT = 88;     // good enough to promote on a single session
const SCORE_QUALIFY = 70;      // counts as consistent, but not promotion on its own
const MIN_COMPLETION = 0.97;   // essentially the whole plan
const SENSOR_MIN_COVERAGE = 0.5;

/** Esforço percebido até aqui significa que a sessão não testou nada. */
const RPE_TOO_EASY = 3;

/** Beyond this the session was harder than prescribed, not better. */
const OVERCOOK_INTENSITY = 0.92;   // avg BPM as a fraction of max HR
const OVERCOOK_Z5_SHARE = 0.25;    // fraction of time in zone 5

export function getLadderIndex(planId) {
  return LADDER.indexOf(planId);
}

export function isLadderPlan(planId) {
  return LADDER.includes(planId);
}

// getMaxHR used to live here as a second copy of `220 - age` with its own fallback. It is
// now in js/physiology.js, and evaluateSession goes through a ZoneCalculator instead.

/** Marca um degrau como pulado, liberando o próximo. */
export function skipStep(planId) {
  const skipped = new Set(Storage.getSettings().skippedSteps || []);
  skipped.add(planId);
  Storage.saveSettings({ skippedSteps: [...skipped] });
}

/** Desfaz todos os pulos — a escada volta a ser derivada só do histórico. */
export function resetSkipped() {
  Storage.saveSettings({ skippedSteps: [] });
}

export function hasSkipped() {
  return (Storage.getSettings().skippedSteps || []).length > 0;
}

// ── Session evaluation ───────────────────────────────────────────────────────

/**
 * Maps each recorded second onto the plan phase that was running at the time and
 * measures how close the rider stayed to what that phase asked for.
 *
 * @returns {null|object} null when the session cannot be judged (not a ladder plan)
 */
export function evaluateSession(summary, profile) {
  if (!summary || !summary.planId) return null;

  const plan = Plans.getAllPlans().find(p => p.id === summary.planId);
  if (!plan || !Array.isArray(plan.phases) || plan.phases.length === 0) return null;

  // As fases que foram de fato pedaladas. Treinos de catálogo saem com a duração ajustada
  // ao histórico de cada um (personalization.js), e julgar a versão de 20 min contra o
  // plano-base de 30 daria 66% de conclusão a quem fez tudo. Treinos gravados antes disto
  // não têm o snapshot e caem no plano atual, que para eles é o mesmo.
  const phases = Array.isArray(summary.planPhases) && summary.planPhases.length
    ? summary.planPhases
    : plan.phases;

  // Built from the ride's own snapshot, so re-judging an old session after a profile
  // edit gives the same verdict it did on the day.
  const zoneCalc = zoneCalcFromSummary(summary, profile);
  const planDuration = phases.reduce((sum, p) => sum + p.duration, 0);

  // Phase boundaries in seconds of elapsed workout time. Paused time is excluded from
  // both the recorder's clock and the guided phase clock, so the two stay aligned.
  const bounds = [];
  let acc = 0;
  for (const phase of phases) {
    bounds.push({ phase, start: acc, end: acc + phase.duration });
    acc += phase.duration;
  }

  const points = Array.isArray(summary.dataPoints) ? summary.dataPoints : [];

  // Tudo ponderado por SEGUNDOS, não por número de amostras.
  //
  // A amostragem não é uniforme: com o app em segundo plano um data point pode representar
  // 60 s em vez de 1 s. Contar amostras dava a esses 60 s o mesmo peso de um segundo bem
  // amostrado, distorcendo aderência e cobertura. `dp.dtMs || 1000` mantém a compatibilidade
  // com tudo que foi gravado antes de dtMs existir — lá o intervalo era mesmo 1 s.
  let hrSeconds = 0, hrOnTarget = 0, hrClose = 0;
  let rpmSeconds = 0, rpmOnTarget = 0, rpmClose = 0;
  let totalSeconds = 0;
  let z5Seconds = 0;

  for (const dp of points) {
    const sec = Math.floor((dp.timestamp || 0) / 1000);
    const slot = bounds.find(b => sec >= b.start && sec < b.end);
    if (!slot) continue;

    const weight = (dp.dtMs || 1000) / 1000;
    totalSeconds += weight;

    if (dp.zoneId === 5) z5Seconds += weight;

    if (dp.bpm > 0) {
      hrSeconds += weight;
      const target = Plans.resolvePhaseBPM(slot.phase, zoneCalc);
      const verdict = Plans.evaluateTarget(dp.bpm, target.min, target.max);
      if (verdict === 'on_target') hrOnTarget += weight;
      else if (verdict === 'close_below' || verdict === 'close_above') hrClose += weight;
    }

    if (dp.rpm > 0) {
      rpmSeconds += weight;
      const verdict = Plans.evaluateTarget(dp.rpm, slot.phase.rpmMin, slot.phase.rpmMax);
      if (verdict === 'on_target') rpmOnTarget += weight;
      else if (verdict === 'close_below' || verdict === 'close_above') rpmClose += weight;
    }
  }

  // "Close" counts as half credit — near the window is worth something, but not the same
  // as holding it.
  const zoneAdherence = hrSeconds > 0 ? (hrOnTarget + hrClose * 0.5) / hrSeconds : null;
  const cadenceAdherence = rpmSeconds > 0 ? (rpmOnTarget + rpmClose * 0.5) / rpmSeconds : null;

  const completion = planDuration > 0
    ? Math.min(1, (summary.durationSeconds || 0) / planDuration)
    : 0;

  const hrCoverage = totalSeconds > 0 ? hrSeconds / totalSeconds : 0;
  const rpmCoverage = totalSeconds > 0 ? rpmSeconds / totalSeconds : 0;
  const z5Share = totalSeconds > 0 ? z5Seconds / totalSeconds : 0;
  // Intensity in whichever model the zones use, so the OVERCOOK_INTENSITY threshold means
  // the same thing as the zone boundaries it is compared against.
  const avgIntensity = summary.avgBPM > 0 ? zoneCalc.intensityOf(summary.avgBPM) : null;

  const hasHR = hrCoverage >= SENSOR_MIN_COVERAGE && zoneAdherence !== null;
  const hasCadence = rpmCoverage >= SENSOR_MIN_COVERAGE && cadenceAdherence !== null;

  // Weights are renormalised over the signals actually available, so a session ridden
  // without the cadence sensor is not silently punished for it.
  let score = 0, weight = 0;
  score += completion * 40; weight += 40;
  if (hasHR) { score += zoneAdherence * 35; weight += 35; }
  if (hasCadence) { score += cadenceAdherence * 25; weight += 25; }
  score = weight > 0 ? Math.round((score / weight) * 100) : 0;

  const overcooked = (avgIntensity !== null && avgIntensity > OVERCOOK_INTENSITY)
    || z5Share > OVERCOOK_Z5_SHARE;

  return {
    planId: plan.id,
    planName: plan.name,
    date: summary.date,
    score,
    completion,
    zoneAdherence,
    cadenceAdherence,
    hrCoverage,
    rpmCoverage,
    avgIntensity,
    /** Em qual modelo avgIntensity está expresso — o rótulo depende disto. */
    reserveBased: zoneCalc.isReserveBased(),
    z5Share,
    overcooked,
    hasHR,
    hasCadence,
    /** Esforço percebido informado no resumo, 0 quando não preenchido. */
    rpe: summary.rpe || 0,
    calories: summary.calories || 0,
    avgBPM: summary.avgBPM || 0,
    avgRPM: summary.avgRPM || 0,
    planDuration,
  };
}

// ── Verdict ─────────────────────────────────────────────────────────────────

/**
 * The coaching call for a session, in the context of previous attempts at the same plan.
 *
 * @returns {{action, title, message, reasons: string[], nextPlanId: string|null}}
 */
/**
 * Veredito para plano personalizado.
 *
 * Não promove nem bloqueia nada — planos custom estão fora da escada de propósito, porque
 * não há como calibrar a dificuldade de um plano que o próprio usuário montou. Mas a
 * avaliação já era calculada por inteiro e descartada: a nota e a aderência dizem se você
 * segurou o que o SEU plano pediu, e isso vale por si.
 */
export function judgeCustom(evaluation) {
  const reasons = buildReasons(evaluation);

  if (!evaluation.hasHR) {
    return {
      action: 'repeat',
      title: 'Sem frequência cardíaca para avaliar',
      message: 'Conecte a cinta ou o relógio para eu medir o quanto você segurou as zonas deste treino.',
      reasons,
      nextPlanId: null,
    };
  }

  if (evaluation.completion < 0.9) {
    return {
      action: 'repeat',
      title: 'Treino não concluído',
      message: `Você fez ${Math.round(evaluation.completion * 100)}% do treino.`,
      reasons,
      nextPlanId: null,
    };
  }

  if (evaluation.score >= SCORE_STANDOUT) {
    return {
      action: 'advance',
      title: 'Execução muito boa',
      message: 'Você segurou o que este treino pediu com folga. A próxima sugestão já vem um pouco mais longa.',
      reasons,
      nextPlanId: null,
    };
  }

  if (evaluation.score >= SCORE_QUALIFY) {
    return {
      action: 'consolidate',
      title: 'Boa execução',
      message: 'Dentro do que o treino pedia, com alguns trechos fora da janela.',
      reasons,
      nextPlanId: null,
    };
  }

  return {
    action: 'repeat',
    title: 'Longe do que o treino pedia',
    message: 'Boa parte do tempo ficou fora das zonas e cadências do treino — talvez ele esteja duro demais para agora.',
    reasons,
    nextPlanId: null,
  };
}

export function judge(evaluation, previousEvaluations = []) {
  // Mesma régua que getLadderState aplica: uma sessão abandonada na metade não conta como
  // evidência prévia. Sem o filtro de completion, o veredito prometia subir e a escada na
  // home dizia que ainda faltava uma sessão — o docstring do módulo afirmava que os dois
  // concordavam, e não concordavam.
  const priorQualifying = previousEvaluations
    .filter(e => e.score >= SCORE_QUALIFY && e.completion >= 0.9).length;
  const nextPlanId = getNextPlanId(evaluation.planId);
  const reasons = buildReasons(evaluation);

  // Sem frequência cardíaca não há como saber se o esforço foi o prescrito.
  //
  // O score é renormalizado sobre os sinais disponíveis, então sem cinta e sem sensor de
  // cadência ele virava `completion × 100` = 100 — acima do limiar de promoção. Dava para
  // subir os 12 degraus da escada apertando "iniciar" e esperando o tempo passar.
  if (!evaluation.hasHR) {
    return {
      action: 'repeat',
      title: 'Não dá para avaliar sem frequência cardíaca',
      message: 'Terminar o tempo não diz se você segurou as zonas pedidas. Conecte a cinta ou o relógio e repita este treino para eu poder liberar o próximo.',
      reasons,
      nextPlanId,
    };
  }

  // Esforço percebido é o único sinal que contradiz sensores: se você marcou "muito leve",
  // a sessão não foi o teste que a promoção pressupõe, por melhor que estejam os números.
  if (evaluation.rpe > 0 && evaluation.rpe <= RPE_TOO_EASY) {
    return {
      action: 'repeat',
      title: 'Leve demais para promover',
      message: `Você marcou esforço ${evaluation.rpe}/10. Repita segurando um ritmo que exija de você — subir a partir de uma sessão fácil só antecipa a estagnação.`,
      reasons,
      nextPlanId,
    };
  }

  if (evaluation.completion < 0.9) {
    return {
      action: 'repeat',
      title: 'Fique mais uma sessão neste treino',
      message: `Você completou ${Math.round(evaluation.completion * 100)}% do plano. Termine ele inteiro antes de pensar em subir.`,
      reasons,
      nextPlanId,
    };
  }

  if (evaluation.overcooked) {
    return {
      action: 'consolidate',
      title: 'Consolide antes de subir',
      message: 'Você passou tempo demais acima do prescrito. Subir agora aumenta o risco de estagnar por fadiga — repita este treino segurando mais o ritmo.',
      reasons,
      nextPlanId,
    };
  }

  const eligible = evaluation.score >= SCORE_ADVANCE && evaluation.completion >= MIN_COMPLETION;
  const standout = evaluation.score >= SCORE_STANDOUT;

  if (eligible && (standout || priorQualifying >= 1)) {
    if (!nextPlanId) {
      return {
        action: 'graduated',
        title: 'Você chegou ao topo da escada',
        message: 'Não há treino mais duro na progressão. Mantenha este nível e use os treinos personalizados para variar.',
        reasons,
        nextPlanId: null,
      };
    }
    const next = Plans.getAllPlans().find(p => p.id === nextPlanId);
    return {
      action: 'advance',
      title: 'Pode subir para o próximo',
      message: standout && priorQualifying === 0
        ? `Sessão muito acima do exigido. Já dá para encarar "${next?.name}".`
        : `Segunda sessão consistente neste treino. Está pronto para "${next?.name}".`,
      reasons,
      nextPlanId,
    };
  }

  if (eligible) {
    return {
      action: 'repeat',
      title: 'Quase lá — mais uma sessão',
      message: 'Sessão boa. Um professor pede consistência antes de subir a régua: repita este treino mais uma vez com o mesmo desempenho.',
      reasons,
      nextPlanId,
    };
  }

  return {
    action: 'repeat',
    title: 'Fique mais uma sessão neste treino',
    message: 'Ainda dá para melhorar a aderência ao que o plano pede. Foque nos pontos abaixo.',
    reasons,
    nextPlanId,
  };
}

function buildReasons(e) {
  const out = [];

  out.push(e.completion >= MIN_COMPLETION
    ? { good: true, text: 'Completou o plano inteiro' }
    : { good: false, text: `Completou ${Math.round(e.completion * 100)}% do plano` });

  if (e.hasHR) {
    const pct = Math.round(e.zoneAdherence * 100);
    out.push(pct >= 70
      ? { good: true, text: `${pct}% do tempo na zona cardíaca pedida` }
      : { good: false, text: `Só ${pct}% do tempo na zona cardíaca pedida` });
  } else {
    out.push({ good: null, text: 'Sem dados de FC suficientes — conecte o sensor para eu avaliar melhor' });
  }

  if (e.hasCadence) {
    const pct = Math.round(e.cadenceAdherence * 100);
    out.push(pct >= 60
      ? { good: true, text: `${pct}% do tempo na cadência pedida` }
      : { good: false, text: `Só ${pct}% do tempo na cadência pedida` });
  } else {
    out.push({ good: null, text: 'Sem dados de cadência — conecte o sensor para eu avaliar melhor' });
  }

  if (e.avgIntensity !== null) {
    const pct = Math.round(e.avgIntensity * 100);
    // avgIntensity vem de zoneCalc.intensityOf(), que é % da reserva quando há FC de
    // repouso no perfil. Chamar isso de "FC máxima" inflava o número em 15-25 pontos.
    const base = e.reserveBased ? 'da reserva de FC' : 'da FC máxima';
    if (e.overcooked) out.push({ good: false, text: `Intensidade média em ${pct}% ${base} — acima do prescrito` });
    else out.push({ good: true, text: `Intensidade média em ${pct}% ${base}` });
  }

  out.push({ good: true, text: `${e.calories} kcal queimadas` });

  return out;
}

// ── Ladder position ─────────────────────────────────────────────────────────

export function getNextPlanId(planId) {
  const i = getLadderIndex(planId);
  if (i < 0 || i >= LADDER.length - 1) return null;
  return LADDER[i + 1];
}

/** All evaluated sessions for a plan, newest first. */
export function getSessionsFor(planId, profile) {
  return Storage.getWorkouts().filter(Storage.countsAsTraining)
    .filter(w => w.planId === planId)
    .map(w => evaluateSession(w, profile))
    .filter(Boolean);
}

/**
 * How far up the ladder the rider has earned their way.
 *
 * A step counts as cleared once it has two qualifying sessions, or one standout —
 * the same rule `judge` applies, so the home screen and the post-workout verdict can
 * never disagree.
 */
export function getLadderState(profile) {
  // Sessões do simulador não podem limpar degrau. As curtas demais também não contam como
  // tentativa: dois inícios acidentais de 10 s liberavam o botão de pular o degrau.
  const workouts = Storage.getWorkouts().filter(Storage.countsAsTraining);
  const byPlan = new Map();

  for (const w of workouts) {
    if (!w.planId || !isLadderPlan(w.planId)) continue;
    const e = evaluateSession(w, profile);
    if (!e) continue;
    if (!byPlan.has(w.planId)) byPlan.set(w.planId, []);
    byPlan.get(w.planId).push(e);
  }

  const steps = LADDER.map((planId, index) => {
    const attempts = byPlan.get(planId) || [];
    // Só sessões com frequência cardíaca contam para limpar o degrau, pelo mesmo motivo
    // que em judge(): sem cinta o score é completion×100 e qualquer sessão terminada
    // limparia a escada sem ninguém ter pedalado forte. Elas seguem contando como
    // tentativa, porque foram.
    const sessions = attempts.filter(s => s.hasHR);
    const qualifying = sessions.filter(s => s.score >= SCORE_QUALIFY && s.completion >= 0.9);
    const standout = sessions.some(s => s.score >= SCORE_STANDOUT && s.completion >= MIN_COMPLETION);
    const cleared = standout || qualifying.length >= 2;
    const best = sessions.reduce((m, s) => Math.max(m, s.score), 0);

    return {
      planId,
      index,
      plan: Plans.getAllPlans().find(p => p.id === planId) || null,
      attempts: attempts.length,
      qualifying: qualifying.length,
      bestScore: best,
      cleared,
    };
  });

  // Degraus que o usuário decidiu pular.
  //
  // Sem isto a escada podia travar para sempre: quem não conseguisse limpar um degrau
  // ficava preso nele, sem nenhum caminho de saída no código. Um plano pode simplesmente
  // não servir para a pessoa — lesão antiga, bike sem carga suficiente, o que for — e o
  // motor não tinha como saber disso.
  const skipped = new Set(Storage.getSettings().skippedSteps || []);
  for (const s of steps) {
    if (skipped.has(s.planId)) s.skipped = true;
  }

  // Degrau atual = o primeiro que não foi limpo nem pulado.
  const currentIndex = steps.findIndex(s => !s.cleared && !s.skipped);
  const current = currentIndex === -1 ? null : steps[currentIndex];

  for (const s of steps) {
    s.status = s.cleared ? 'cleared'
      : s.skipped ? 'skipped'
      : (current && s.index === current.index) ? 'current'
      : 'locked';
  }

  return {
    steps,
    current,
    currentIndex: currentIndex === -1 ? LADDER.length : currentIndex,
    graduated: currentIndex === -1,
    totalSteps: LADDER.length,
  };
}

/** One-line coaching prompt for the home screen. */
export function getNextStepHint(profile) {
  const state = getLadderState(profile);
  if (state.graduated) {
    return { title: 'Escada concluída', text: 'Você passou por todos os 12 treinos guiados.', planId: null, state };
  }

  const step = state.current;
  const name = step.plan?.name || step.planId;

  if (step.attempts === 0) {
    return {
      title: 'Este treino começa aqui',
      text: `"${name}" é o seu próximo passo. Complete ele para eu avaliar se dá para subir.`,
      planId: step.planId,
      state,
    };
  }

  const faltam = Math.max(1, 2 - step.qualifying);
  return {
    title: 'Continue neste treino',
    text: `"${name}" — melhor nota até agora: ${step.bestScore}/100. Faltam ${faltam} sessão(ões) consistente(s) para subir.`,
    planId: step.planId,
    state,
  };
}
