import { ZONES } from './zone-calculator.js';

// ── Treinos Pré-definidos ──
// zone: ID da zona (1-5), BPM é calculado baseado no perfil do usuário
const PREBUILT_PLANS = [
  {
    id: 'primeiro_pedal',
    name: 'Primeiro Pedal',
    emoji: '🌱',
    description: 'Seu primeiro treino na bike. Foque em manter um ritmo confortável e curtir a pedalada.',
    difficulty: 'Iniciante',
    focus: 'Adaptação',
    phases: [
      { name: 'Aquecimento', duration: 180, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Comece devagar, ajuste posição e resistência' },
      { name: 'Pedalada Base', duration: 480, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Ritmo estável, respire naturalmente' },
      { name: 'Volta à Calma', duration: 240, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Reduza a resistência gradualmente' },
    ]
  },
  {
    id: 'queima_suave',
    name: 'Queima Suave',
    emoji: '🔥',
    description: 'Queima de gordura em ritmo constante. Ideal para manter a Z2 e maximizar o uso de gordura como combustível.',
    difficulty: 'Iniciante',
    focus: 'Queima de Gordura',
    phases: [
      { name: 'Aquecimento', duration: 240, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Pedale leve para preparar o corpo' },
      { name: 'Queima Estável', duration: 720, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Mantenha a zona 2 — aqui a gordura queima mais' },
      { name: 'Volta à Calma', duration: 240, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Desacelere suavemente' },
    ]
  },
  {
    id: 'intervalado_leve',
    name: 'Intervalado Leve',
    emoji: '⚡',
    description: 'Alternância entre esforço moderado e recuperação. Acelera o metabolismo e melhora o condicionamento.',
    difficulty: 'Iniciante',
    focus: 'Condicionamento',
    phases: [
      { name: 'Aquecimento', duration: 240, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Prepare o corpo para os intervalos' },
      { name: 'Esforço 1', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Aumente a resistência, force um pouco!' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Diminua a resistência, recupere o fôlego' },
      { name: 'Esforço 2', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Vamos de novo! Mantenha o ritmo' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Respire fundo, relaxe as pernas' },
      { name: 'Esforço 3', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Último esforço, você consegue!' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Quase lá, recupere' },
      { name: 'Volta à Calma', duration: 240, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Ótimo trabalho! Desacelere' },
    ]
  },
  {
    id: 'queima_progressiva',
    name: 'Queima Progressiva',
    emoji: '📈',
    description: 'Intensidade cresce aos poucos. Seu corpo aquece gradualmente e maximiza a queima calórica total.',
    difficulty: 'Iniciante+',
    focus: 'Queima Máxima',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Comece tranquilo' },
      { name: 'Base', duration: 300, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Encontre seu ritmo na Z2' },
      { name: 'Progressão', duration: 300, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Aumente um pouco a resistência' },
      { name: 'Pico', duration: 300, zone: 3, rpmMin: 75, rpmMax: 85, tip: 'Zona 3! Esforce-se, mas respire' },
      { name: 'Recuperação', duration: 300, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Reduza, recupere na Z2' },
      { name: 'Volta à Calma', duration: 300, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Excelente treino! Relaxe agora' },
    ]
  }
];

// ── Storage ──
const CUSTOM_PLANS_KEY = 'spinsync_custom_plans';

export function getPrebuiltPlans() {
  return PREBUILT_PLANS;
}

export function getCustomPlans() {
  const data = localStorage.getItem(CUSTOM_PLANS_KEY);
  return data ? JSON.parse(data) : [];
}

export function getAllPlans() {
  return [...PREBUILT_PLANS, ...getCustomPlans()];
}

export function saveCustomPlan(plan) {
  const plans = getCustomPlans();
  const existingIdx = plans.findIndex(p => p.id === plan.id);
  if (existingIdx >= 0) {
    plans[existingIdx] = plan;
  } else {
    plans.push(plan);
  }
  localStorage.setItem(CUSTOM_PLANS_KEY, JSON.stringify(plans));
}

export function deleteCustomPlan(id) {
  const plans = getCustomPlans().filter(p => p.id !== id);
  localStorage.setItem(CUSTOM_PLANS_KEY, JSON.stringify(plans));
}

// ── Helpers ──

export function getPlanDuration(plan) {
  return plan.phases.reduce((sum, p) => sum + p.duration, 0);
}

export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (s === 0) return `${m} min`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function getPhaseZone(phase) {
  return ZONES.find(z => z.id === phase.zone) || ZONES[0];
}

/**
 * Resolve BPM targets baseado no perfil do usuário.
 */
export function resolvePhaseBPM(phase, maxHR) {
  const zone = ZONES.find(z => z.id === phase.zone);
  if (!zone) return { min: 0, max: 0 };
  return {
    min: Math.round(zone.minPct * maxHR),
    max: Math.round(zone.maxPct * maxHR)
  };
}

/**
 * Avalia se o valor atual está no alvo.
 * @returns {'below'|'on_target'|'above'|'close_below'|'close_above'}
 */
export function evaluateTarget(current, min, max) {
  if (current <= 0) return 'no_data';
  const range = max - min;
  const margin = Math.max(range * 0.15, 5); // 15% margin ou 5 unidades
  
  if (current >= min && current <= max) return 'on_target';
  if (current < min && current >= min - margin) return 'close_below';
  if (current > max && current <= max + margin) return 'close_above';
  if (current < min) return 'below';
  return 'above';
}
