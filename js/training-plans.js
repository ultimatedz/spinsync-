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
  },

  // ── Treinos Intermediários ──
  {
    id: 'subida_simulada',
    name: 'Subida Simulada',
    emoji: '🏔️',
    description: 'Simule uma subida de montanha com resistência crescente. Trabalhe força nas pernas e resistência cardiovascular.',
    difficulty: 'Intermediário',
    focus: 'Força',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Pedale leve, prepare as pernas' },
      { name: 'Planície', duration: 240, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Ritmo confortável na Z2' },
      { name: 'Subida Leve', duration: 300, zone: 3, rpmMin: 60, rpmMax: 70, tip: 'Aumente a resistência, reduza a cadência' },
      { name: 'Subida Forte', duration: 240, zone: 4, rpmMin: 55, rpmMax: 65, tip: 'Resistência alta! Força nas pernas, respire fundo' },
      { name: 'Cume', duration: 180, zone: 4, rpmMin: 50, rpmMax: 60, tip: 'Último esforço! Você está no topo!' },
      { name: 'Descida', duration: 240, zone: 2, rpmMin: 75, rpmMax: 85, tip: 'Reduza resistência, aumente cadência' },
      { name: 'Volta à Calma', duration: 180, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Ótimo trabalho, descanse' },
    ]
  },
  {
    id: 'tabata_spinning',
    name: 'Tabata Spinning',
    emoji: '💥',
    description: 'Protocolo HIIT adaptado para spinning. Intervalos curtos de alta intensidade com recuperação ativa.',
    difficulty: 'Intermediário',
    focus: 'HIIT',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Prepare o corpo para a intensidade' },
      { name: 'Sprint 1', duration: 60, zone: 4, rpmMin: 90, rpmMax: 110, tip: 'MÁXIMA velocidade! Dê tudo!' },
      { name: 'Recuperação', duration: 90, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Recupere, respire fundo' },
      { name: 'Sprint 2', duration: 60, zone: 4, rpmMin: 90, rpmMax: 110, tip: 'Explosão! Vamos de novo!' },
      { name: 'Recuperação', duration: 90, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Acalme a respiração' },
      { name: 'Sprint 3', duration: 60, zone: 4, rpmMin: 90, rpmMax: 110, tip: 'Mantenha a potência!' },
      { name: 'Recuperação', duration: 90, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Quase lá, recupere' },
      { name: 'Sprint 4', duration: 60, zone: 4, rpmMin: 90, rpmMax: 110, tip: 'Último sprint! Dê tudo!' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Bom trabalho, recupere' },
      { name: 'Sprint 5', duration: 60, zone: 4, rpmMin: 90, rpmMax: 110, tip: 'Mais um! Você consegue!' },
      { name: 'Recuperação', duration: 90, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Respire, quase acabou' },
      { name: 'Sprint 6', duration: 60, zone: 4, rpmMin: 90, rpmMax: 110, tip: 'ÚLTIMO! Tudo que tem!' },
      { name: 'Volta à Calma', duration: 300, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Excelente sessão! Desacelere' },
    ]
  },
  {
    id: 'resistencia_progressiva',
    name: 'Resistência Progressiva',
    emoji: '🔗',
    description: 'Treino de endurance com blocos progressivos. Constrói resistência cardiovascular de forma inteligente.',
    difficulty: 'Intermediário',
    focus: 'Endurance',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Comece suave' },
      { name: 'Base Estável', duration: 420, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Encontre seu ritmo sustentável' },
      { name: 'Progressão 1', duration: 300, zone: 3, rpmMin: 70, rpmMax: 80, tip: 'Suba para Z3, mantenha' },
      { name: 'Recuperação Ativa', duration: 180, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Volte à Z2, sem parar' },
      { name: 'Progressão 2', duration: 300, zone: 3, rpmMin: 72, rpmMax: 82, tip: 'Z3 novamente, um pouco mais forte' },
      { name: 'Recuperação Ativa', duration: 180, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Recupere na Z2' },
      { name: 'Volta à Calma', duration: 240, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Ótimo endurance! Relaxe' },
    ]
  },
  {
    id: 'piramide_potencia',
    name: 'Pirâmide de Potência',
    emoji: '🔺',
    description: 'Suba e desça a pirâmide de intensidade. Cada degrau é mais intenso até o pico, depois volta.',
    difficulty: 'Intermediário',
    focus: 'Potência',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Prepare-se para a pirâmide' },
      { name: 'Degrau 1 ↑', duration: 240, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Primeiro nível — Z2' },
      { name: 'Degrau 2 ↑', duration: 240, zone: 3, rpmMin: 70, rpmMax: 80, tip: 'Subindo — Z3' },
      { name: 'Topo 🔥', duration: 180, zone: 4, rpmMin: 75, rpmMax: 90, tip: 'PICO da pirâmide! Máximo esforço Z4!' },
      { name: 'Degrau 2 ↓', duration: 240, zone: 3, rpmMin: 70, rpmMax: 80, tip: 'Descendo — volte à Z3' },
      { name: 'Degrau 1 ↓', duration: 240, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Quase na base — Z2' },
      { name: 'Volta à Calma', duration: 300, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Pirâmide completa! Relaxe' },
    ]
  },

  // ── Treinos Avançados ──
  {
    id: 'sprint_recover',
    name: 'Sprint & Recover',
    emoji: '🚀',
    description: 'Sprints explosivos com recuperação total. Treino de velocidade pura que leva sua FC ao limite.',
    difficulty: 'Avançado',
    focus: 'Velocidade',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Aqueça bem, vai ser intenso' },
      { name: 'Ativação', duration: 240, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Ative os músculos na Z2' },
      { name: 'Sprint 1', duration: 45, zone: 5, rpmMin: 100, rpmMax: 120, tip: '🔥 SPRINT TOTAL! Máxima cadência!' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Recupere completamente' },
      { name: 'Sprint 2', duration: 45, zone: 5, rpmMin: 100, rpmMax: 120, tip: '🔥 Mais rápido que o anterior!' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Respire, foque na próxima' },
      { name: 'Sprint 3', duration: 60, zone: 5, rpmMin: 100, rpmMax: 120, tip: '🔥 Sprint mais longo! Aguente!' },
      { name: 'Recuperação', duration: 150, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Recuperação maior, prepare-se' },
      { name: 'Sprint 4', duration: 45, zone: 5, rpmMin: 100, rpmMax: 120, tip: '🔥 Penúltimo! Dê tudo!' },
      { name: 'Recuperação', duration: 120, zone: 2, rpmMin: 55, rpmMax: 65, tip: 'Recuperação ativa' },
      { name: 'Sprint Final', duration: 60, zone: 5, rpmMin: 100, rpmMax: 120, tip: '🔥 ÚLTIMO SPRINT! TUDO QUE TEM!' },
      { name: 'Volta à Calma', duration: 420, zone: 1, rpmMin: 40, rpmMax: 50, tip: 'Fantástico! Desacelere devagar' },
    ]
  },
  {
    id: 'montanha_russa',
    name: 'Montanha Russa',
    emoji: '🎢',
    description: 'Sobe e desce sem parar. Treino completo que trabalha todas as zonas e simula terrenos variados.',
    difficulty: 'Avançado',
    focus: 'Completo',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Prepare-se para a aventura' },
      { name: 'Subida 1', duration: 180, zone: 3, rpmMin: 65, rpmMax: 75, tip: 'Primeira subida — Z3' },
      { name: 'Descida 1', duration: 120, zone: 2, rpmMin: 80, rpmMax: 90, tip: 'Descida rápida!' },
      { name: 'Subida 2', duration: 180, zone: 4, rpmMin: 60, rpmMax: 70, tip: 'Subida forte — Z4!' },
      { name: 'Planície', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Recupere na planície' },
      { name: 'Subida 3', duration: 120, zone: 4, rpmMin: 55, rpmMax: 65, tip: 'Subida curta e intensa' },
      { name: 'Descida 2', duration: 120, zone: 2, rpmMin: 80, rpmMax: 90, tip: 'Descida! Cadência alta' },
      { name: 'Pico Final', duration: 90, zone: 5, rpmMin: 70, rpmMax: 85, tip: '🔥 O pico da montanha! Z5!' },
      { name: 'Descida Final', duration: 180, zone: 2, rpmMin: 75, rpmMax: 85, tip: 'Última descida, quase lá' },
      { name: 'Subida 4', duration: 150, zone: 3, rpmMin: 65, rpmMax: 75, tip: 'Uma subida final moderada' },
      { name: 'Planície Final', duration: 180, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Terreno plano para fechar' },
      { name: 'Volta à Calma', duration: 360, zone: 1, rpmMin: 40, rpmMax: 55, tip: 'Montanha russa completa! Descanse' },
    ]
  },
  {
    id: 'resistencia_extrema',
    name: 'Resistência Extrema',
    emoji: '🔥💪',
    description: 'O treino mais longo. 50 minutos de endurance com blocos sustentados em Z3/Z4. Para quem quer ir além.',
    difficulty: 'Avançado',
    focus: 'Endurance Max',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Aqueça devagar, treino longo pela frente' },
      { name: 'Ativação', duration: 300, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Construa o ritmo' },
      { name: 'Bloco Sustentado 1', duration: 480, zone: 3, rpmMin: 70, rpmMax: 80, tip: 'Mantenha Z3 por 8 minutos — ritmo constante' },
      { name: 'Recuperação Ativa', duration: 180, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Respire, não pare de pedalar' },
      { name: 'Bloco Sustentado 2', duration: 420, zone: 3, rpmMin: 72, rpmMax: 82, tip: 'Z3 novamente, um pouco mais forte' },
      { name: 'Push Zone', duration: 180, zone: 4, rpmMin: 70, rpmMax: 80, tip: 'Suba para Z4! Teste seu limite' },
      { name: 'Recuperação', duration: 180, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Recupere, falta pouco' },
      { name: 'Bloco Final', duration: 360, zone: 3, rpmMin: 70, rpmMax: 80, tip: 'Último bloco sustentado — force!' },
      { name: 'Volta à Calma', duration: 360, zone: 1, rpmMin: 40, rpmMax: 55, tip: 'Incrível! 50 min de treino. Relaxe' },
    ]
  },
  {
    id: 'the_finisher',
    name: 'The Finisher',
    emoji: '☠️',
    description: 'Só para os corajosos. Blocos intensos em Z4/Z5 com pouca recuperação. O treino mais difícil do SpinSync.',
    difficulty: 'Avançado',
    focus: 'Potência Max',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 60, rpmMax: 70, tip: 'Última chance de voltar... 😈' },
      { name: 'Ativação', duration: 240, zone: 3, rpmMin: 70, rpmMax: 80, tip: 'Direto na Z3 para aquecer' },
      { name: 'Ataque 1', duration: 120, zone: 4, rpmMin: 80, rpmMax: 95, tip: '🔥 Z4! Comece forte!' },
      { name: 'Micro Recuperação', duration: 60, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Só 1 minuto! Aproveite' },
      { name: 'Ataque 2', duration: 120, zone: 4, rpmMin: 80, rpmMax: 95, tip: '🔥 Mais forte que o anterior!' },
      { name: 'Micro Recuperação', duration: 60, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Respire rápido' },
      { name: 'Ataque 3', duration: 90, zone: 5, rpmMin: 85, rpmMax: 100, tip: '☠️ Z5!! Dê absolutamente TUDO!' },
      { name: 'Recuperação', duration: 120, zone: 2, rpmMin: 55, rpmMax: 65, tip: 'Recuperação antes do final' },
      { name: 'Ataque 4', duration: 120, zone: 4, rpmMin: 80, rpmMax: 95, tip: '🔥 Penúltimo ataque!' },
      { name: 'Micro Recuperação', duration: 60, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Último respiro...' },
      { name: 'Ataque Final', duration: 90, zone: 5, rpmMin: 85, rpmMax: 100, tip: '☠️ TUDO QUE SOBROU! FINAL!' },
      { name: 'Volta à Calma', duration: 420, zone: 1, rpmMin: 40, rpmMax: 50, tip: 'Você sobreviveu ao Finisher! 🏆' },
    ]
  }
];

// ── Storage ──
const CUSTOM_PLANS_KEY = 'spinsync_custom_plans';

export function getPrebuiltPlans() {
  return PREBUILT_PLANS;
}

export function getCustomPlans() {
  // A corrupted value used to throw during app construction and leave a black screen.
  try {
    const data = localStorage.getItem(CUSTOM_PLANS_KEY);
    if (!data) return [];
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('[Plans] Corrupted custom plans, discarding:', e);
    try { localStorage.removeItem(CUSTOM_PLANS_KEY); } catch (_) { /* ignore */ }
    return [];
  }
}

export function isCustomPlan(id) {
  return getCustomPlans().some(p => p.id === id);
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
  return writePlans(plans);
}

export function deleteCustomPlan(id) {
  return writePlans(getCustomPlans().filter(p => p.id !== id));
}

function writePlans(plans) {
  try {
    localStorage.setItem(CUSTOM_PLANS_KEY, JSON.stringify(plans));
    return true;
  } catch (e) {
    console.error('[Plans] Failed to write custom plans:', e);
    return false;
  }
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
