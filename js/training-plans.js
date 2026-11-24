import { ZONES } from './zone-calculator.js';

/**
 * Categorias por OBJETIVO, não por nível. O nível continua existindo (difficulty), mas
 * "o que este treino desenvolve" é a pergunta que decide o que fazer hoje.
 */
export const CATEGORIES = [
  {
    id: 'folego',
    name: 'Fôlego',
    desc: 'Base aeróbica e blocos longos em ritmo controlado. Aumenta quanto tempo você sustenta um esforço sem se esgotar.',
  },
  {
    id: 'resistencia',
    name: 'Resistência',
    desc: 'Sessões longas e progressivas, para aguentar mais tempo pedalando.',
  },
  {
    id: 'forca',
    name: 'Força',
    desc: 'Subidas com carga alta e cadência baixa. Trabalha mais as pernas do que o coração.',
  },
  {
    id: 'intervalado',
    name: 'Intervalado',
    desc: 'Tiros curtos e intensos com recuperação entre eles. Pouco tempo, muito estímulo.',
  },
  {
    id: 'recuperacao',
    name: 'Recuperação',
    desc: 'Giro leve para soltar as pernas entre dias fortes.',
  },
];

/** Planos personalizados sem categoria (criados antes dela existir). */
export const CUSTOM_CATEGORY = { id: 'meus', name: 'Meus', desc: 'Treinos que você montou.' };

// ── Treinos Pré-definidos ──
// zone: ID da zona (1-5); o BPM sai do perfil de cada um (resolvePhaseBPM).
//
// ATENÇÃO: as fases dos doze treinos da escada (ver progression.js LADDER) são o que
// evaluateSession usa para julgar sessões JÁ GRAVADAS. Mudar duração, zona ou cadência de
// uma fase reescreveria a nota de treinos antigos. Nome, descrição e dicas podem mudar.
const PREBUILT_PLANS = [
  {
    id: 'primeiro_pedal',
    name: 'Primeiro Pedal',
    category: 'folego',
    description: 'Quinze minutos para se acostumar com a bike e com a leitura das zonas. Ritmo confortável do início ao fim.',
    difficulty: 'Iniciante',
    focus: 'Adaptação',
    phases: [
      { name: 'Aquecimento', duration: 180, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Ajuste o banco e o guidão, carga leve.' },
      { name: 'Pedalada base', duration: 480, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Ritmo em que dá para conversar em frases curtas.' },
      { name: 'Volta à calma', duration: 240, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Tire a carga aos poucos.' },
    ]
  },
  {
    id: 'queima_suave',
    name: 'Base Suave',
    category: 'folego',
    description: 'Doze minutos contínuos em Z2. É o tipo de treino que mais desenvolve o fôlego no longo prazo, sem desgastar.',
    difficulty: 'Iniciante',
    focus: 'Base aeróbica',
    phases: [
      { name: 'Aquecimento', duration: 240, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Carga leve, deixe a FC subir sozinha.' },
      { name: 'Bloco Z2', duration: 720, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Respiração pelo nariz, se conseguir. Segure a zona, não a velocidade.' },
      { name: 'Volta à calma', duration: 240, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Reduza a carga gradualmente.' },
    ]
  },
  {
    id: 'intervalado_leve',
    name: 'Intervalado Leve',
    category: 'intervalado',
    description: 'Três blocos de três minutos um pouco mais fortes, com recuperação entre eles. A porta de entrada para intervalos.',
    difficulty: 'Iniciante',
    focus: 'Condicionamento',
    phases: [
      { name: 'Aquecimento', duration: 240, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Prepare as pernas para os blocos.' },
      { name: 'Bloco 1', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Um pouco mais de carga, cadência estável.' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Alivie a carga e normalize a respiração.' },
      { name: 'Bloco 2', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Mesmo ritmo do primeiro.' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Pernas soltas.' },
      { name: 'Bloco 3', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Último bloco, mesma cadência.' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Recupere antes de desacelerar.' },
      { name: 'Volta à calma', duration: 240, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Reduza a carga gradualmente.' },
    ]
  },
  {
    id: 'queima_progressiva',
    name: 'Progressivo 30',
    category: 'resistencia',
    description: 'Trinta minutos em que a intensidade sobe aos poucos até a Z3 e volta. Treina sustentar esforço por mais tempo.',
    difficulty: 'Iniciante+',
    focus: 'Progressão contínua',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Comece leve.' },
      { name: 'Base', duration: 300, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Encontre um ritmo sustentável na Z2.' },
      { name: 'Progressão', duration: 300, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Um pouco mais de carga, ainda na Z2.' },
      { name: 'Pico', duration: 300, zone: 3, rpmMin: 75, rpmMax: 85, tip: 'Z3: respiração mais forte, mas controlada.' },
      { name: 'Recuperação', duration: 300, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Volte para a Z2 sem parar de pedalar.' },
      { name: 'Volta à calma', duration: 300, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Reduza a carga gradualmente.' },
    ]
  },

  // ── Intermediário ──
  {
    id: 'subida_simulada',
    name: 'Subida Simulada',
    category: 'forca',
    description: 'Carga crescente e cadência caindo, como numa serra. Trabalha força nas pernas.',
    difficulty: 'Intermediário',
    focus: 'Força',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Carga leve, prepare as pernas.' },
      { name: 'Plano', duration: 240, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Ritmo confortável na Z2.' },
      { name: 'Subida leve', duration: 300, zone: 3, rpmMin: 60, rpmMax: 70, tip: 'Mais carga, cadência caindo. Tronco firme.' },
      { name: 'Subida forte', duration: 240, zone: 4, rpmMin: 55, rpmMax: 65, tip: 'Carga alta. Empurre e puxe o pedal.' },
      { name: 'Cume', duration: 180, zone: 4, rpmMin: 50, rpmMax: 60, tip: 'Pode pedalar em pé se precisar.' },
      { name: 'Descida', duration: 240, zone: 2, rpmMin: 75, rpmMax: 85, tip: 'Tire carga e aumente a cadência.' },
      { name: 'Volta à calma', duration: 180, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Pernas soltas.' },
    ]
  },
  {
    id: 'tabata_spinning',
    name: 'Tabata',
    category: 'intervalado',
    description: 'Seis tiros de um minuto com recuperação curta. Treino curto e intenso.',
    difficulty: 'Intermediário',
    focus: 'HIIT',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Aqueça bem antes dos tiros.' },
      { name: 'Tiro 1', duration: 60, zone: 4, rpmMin: 90, rpmMax: 110, tip: 'Cadência alta, carga moderada.' },
      { name: 'Recuperação', duration: 90, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Carga mínima, respire.' },
      { name: 'Tiro 2', duration: 60, zone: 4, rpmMin: 90, rpmMax: 110, tip: 'Mesma cadência do primeiro.' },
      { name: 'Recuperação', duration: 90, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Normalize a respiração.' },
      { name: 'Tiro 3', duration: 60, zone: 4, rpmMin: 90, rpmMax: 110, tip: 'Mantenha a cadência até o fim.' },
      { name: 'Recuperação', duration: 90, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Pernas soltas.' },
      { name: 'Tiro 4', duration: 60, zone: 4, rpmMin: 90, rpmMax: 110, tip: 'Metade feita.' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Recuperação um pouco maior.' },
      { name: 'Tiro 5', duration: 60, zone: 4, rpmMin: 90, rpmMax: 110, tip: 'Cadência alta de novo.' },
      { name: 'Recuperação', duration: 90, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Último descanso.' },
      { name: 'Tiro 6', duration: 60, zone: 4, rpmMin: 90, rpmMax: 110, tip: 'Último tiro.' },
      { name: 'Volta à calma', duration: 300, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Desacelere aos poucos.' },
    ]
  },
  {
    id: 'resistencia_progressiva',
    name: 'Resistência Progressiva',
    category: 'resistencia',
    description: 'Base em Z2 com dois blocos em Z3. Constrói a capacidade de segurar ritmo por mais tempo.',
    difficulty: 'Intermediário',
    focus: 'Endurance',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Comece leve.' },
      { name: 'Base', duration: 420, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Ritmo sustentável.' },
      { name: 'Bloco Z3 1', duration: 300, zone: 3, rpmMin: 70, rpmMax: 80, tip: 'Suba para a Z3 e segure.' },
      { name: 'Recuperação ativa', duration: 180, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Volte à Z2 sem parar.' },
      { name: 'Bloco Z3 2', duration: 300, zone: 3, rpmMin: 72, rpmMax: 82, tip: 'Z3 de novo, um pouco mais firme.' },
      { name: 'Recuperação ativa', duration: 180, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Recupere na Z2.' },
      { name: 'Volta à calma', duration: 240, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Reduza a carga gradualmente.' },
    ]
  },
  {
    id: 'piramide_potencia',
    name: 'Pirâmide',
    category: 'intervalado',
    description: 'Intensidade sobe degrau a degrau até a Z4 e desce do mesmo jeito.',
    difficulty: 'Intermediário',
    focus: 'Potência',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Prepare-se para subir.' },
      { name: 'Degrau 1 (sobe)', duration: 240, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Primeiro degrau, Z2.' },
      { name: 'Degrau 2 (sobe)', duration: 240, zone: 3, rpmMin: 70, rpmMax: 80, tip: 'Z3.' },
      { name: 'Topo', duration: 180, zone: 4, rpmMin: 75, rpmMax: 90, tip: 'Z4: o esforço mais alto do treino.' },
      { name: 'Degrau 2 (desce)', duration: 240, zone: 3, rpmMin: 70, rpmMax: 80, tip: 'Volte para a Z3.' },
      { name: 'Degrau 1 (desce)', duration: 240, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Z2.' },
      { name: 'Volta à calma', duration: 300, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Reduza a carga gradualmente.' },
    ]
  },

  // ── Avançado ──
  {
    id: 'sprint_recover',
    name: 'Sprints',
    category: 'intervalado',
    description: 'Cinco sprints em Z5 com recuperação completa. Velocidade e potência.',
    difficulty: 'Avançado',
    focus: 'Velocidade',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Aqueça bem: o treino é intenso.' },
      { name: 'Ativação', duration: 240, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Z2 para preparar os sprints.' },
      { name: 'Sprint 1', duration: 45, zone: 5, rpmMin: 100, rpmMax: 120, tip: 'Cadência máxima com controle.' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Recupere por completo.' },
      { name: 'Sprint 2', duration: 45, zone: 5, rpmMin: 100, rpmMax: 120, tip: 'Mesma intensidade do primeiro.' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Respire e solte as pernas.' },
      { name: 'Sprint 3', duration: 60, zone: 5, rpmMin: 100, rpmMax: 120, tip: 'Este é mais longo: dose o início.' },
      { name: 'Recuperação', duration: 150, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Recuperação maior.' },
      { name: 'Sprint 4', duration: 45, zone: 5, rpmMin: 100, rpmMax: 120, tip: 'Penúltimo.' },
      { name: 'Recuperação', duration: 120, zone: 2, rpmMin: 55, rpmMax: 65, tip: 'Recuperação ativa.' },
      { name: 'Sprint final', duration: 60, zone: 5, rpmMin: 100, rpmMax: 120, tip: 'Último sprint.' },
      { name: 'Volta à calma', duration: 420, zone: 1, rpmMin: 40, rpmMax: 50, tip: 'Desacelere devagar.' },
    ]
  },
  {
    id: 'montanha_russa',
    name: 'Serra',
    category: 'forca',
    description: 'Subidas e descidas alternadas, passando por todas as zonas. Treino completo de força.',
    difficulty: 'Avançado',
    focus: 'Completo',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Comece leve.' },
      { name: 'Subida 1', duration: 180, zone: 3, rpmMin: 65, rpmMax: 75, tip: 'Primeira subida, Z3.' },
      { name: 'Descida 1', duration: 120, zone: 2, rpmMin: 80, rpmMax: 90, tip: 'Tire carga, cadência alta.' },
      { name: 'Subida 2', duration: 180, zone: 4, rpmMin: 60, rpmMax: 70, tip: 'Subida forte, Z4.' },
      { name: 'Plano', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Recupere no plano.' },
      { name: 'Subida 3', duration: 120, zone: 4, rpmMin: 55, rpmMax: 65, tip: 'Curta e pesada.' },
      { name: 'Descida 2', duration: 120, zone: 2, rpmMin: 80, rpmMax: 90, tip: 'Cadência alta.' },
      { name: 'Pico', duration: 90, zone: 5, rpmMin: 70, rpmMax: 85, tip: 'O ponto mais alto, Z5.' },
      { name: 'Descida 3', duration: 180, zone: 2, rpmMin: 75, rpmMax: 85, tip: 'Recupere descendo.' },
      { name: 'Subida 4', duration: 150, zone: 3, rpmMin: 65, rpmMax: 75, tip: 'Subida final moderada.' },
      { name: 'Plano final', duration: 180, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Terreno plano para fechar.' },
      { name: 'Volta à calma', duration: 360, zone: 1, rpmMin: 40, rpmMax: 55, tip: 'Reduza a carga gradualmente.' },
    ]
  },
  {
    id: 'resistencia_extrema',
    name: 'Resistência Longa',
    category: 'resistencia',
    description: 'Cinquenta minutos com blocos sustentados em Z3 e um trecho em Z4. Para quem já segura 30 minutos com folga.',
    difficulty: 'Avançado',
    focus: 'Endurance longa',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Treino longo: aqueça devagar.' },
      { name: 'Ativação', duration: 300, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Construa o ritmo.' },
      { name: 'Bloco sustentado 1', duration: 480, zone: 3, rpmMin: 70, rpmMax: 80, tip: 'Oito minutos em Z3, ritmo constante.' },
      { name: 'Recuperação ativa', duration: 180, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Não pare de pedalar.' },
      { name: 'Bloco sustentado 2', duration: 420, zone: 3, rpmMin: 72, rpmMax: 82, tip: 'Z3 um pouco mais firme.' },
      { name: 'Bloco Z4', duration: 180, zone: 4, rpmMin: 70, rpmMax: 80, tip: 'Três minutos em Z4.' },
      { name: 'Recuperação', duration: 180, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Recupere para o último bloco.' },
      { name: 'Bloco final', duration: 360, zone: 3, rpmMin: 70, rpmMax: 80, tip: 'Último bloco sustentado.' },
      { name: 'Volta à calma', duration: 360, zone: 1, rpmMin: 40, rpmMax: 55, tip: 'Reduza a carga gradualmente.' },
    ]
  },
  {
    id: 'the_finisher',
    name: 'Ataques',
    category: 'intervalado',
    description: 'Ataques em Z4 e Z5 com pouca recuperação. O treino mais duro do catálogo.',
    difficulty: 'Avançado',
    focus: 'Potência máxima',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 60, rpmMax: 70, tip: 'Aqueça bem.' },
      { name: 'Ativação', duration: 240, zone: 3, rpmMin: 70, rpmMax: 80, tip: 'Z3 para preparar.' },
      { name: 'Ataque 1', duration: 120, zone: 4, rpmMin: 80, rpmMax: 95, tip: 'Z4, cadência alta.' },
      { name: 'Recuperação curta', duration: 60, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Só um minuto.' },
      { name: 'Ataque 2', duration: 120, zone: 4, rpmMin: 80, rpmMax: 95, tip: 'Mesmo ritmo do primeiro.' },
      { name: 'Recuperação curta', duration: 60, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Respire.' },
      { name: 'Ataque 3', duration: 90, zone: 5, rpmMin: 85, rpmMax: 100, tip: 'Z5: o mais forte do treino.' },
      { name: 'Recuperação', duration: 120, zone: 2, rpmMin: 55, rpmMax: 65, tip: 'Recupere antes do final.' },
      { name: 'Ataque 4', duration: 120, zone: 4, rpmMin: 80, rpmMax: 95, tip: 'Penúltimo ataque.' },
      { name: 'Recuperação curta', duration: 60, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Último descanso.' },
      { name: 'Ataque final', duration: 90, zone: 5, rpmMin: 85, rpmMax: 100, tip: 'Z5 até o fim.' },
      { name: 'Volta à calma', duration: 420, zone: 1, rpmMin: 40, rpmMax: 50, tip: 'Desacelere devagar.' },
    ]
  },

  // ── Fora da escada: catálogo por objetivo ──
  // Avaliados como os personalizados (nota e aderência), sem promover degrau.
  {
    id: 'folego_4x2',
    name: 'Fôlego 4×2',
    category: 'folego',
    description: 'Quatro blocos de dois minutos em Z3 com recuperação igual. O primeiro passo para intervalos de fôlego.',
    difficulty: 'Iniciante+',
    focus: 'Capacidade aeróbica',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Carga leve.' },
      { name: 'Ativação', duration: 120, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Z2 para preparar.' },
      { name: 'Bloco 1', duration: 120, zone: 3, rpmMin: 75, rpmMax: 85, tip: 'Z3: respiração forte, mas ritmada.' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 60, rpmMax: 70, tip: 'Alivie a carga.' },
      { name: 'Bloco 2', duration: 120, zone: 3, rpmMin: 75, rpmMax: 85, tip: 'Mesmo ritmo do primeiro.' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 60, rpmMax: 70, tip: 'Respire fundo.' },
      { name: 'Bloco 3', duration: 120, zone: 3, rpmMin: 75, rpmMax: 85, tip: 'Segure a cadência.' },
      { name: 'Recuperação', duration: 120, zone: 1, rpmMin: 60, rpmMax: 70, tip: 'Último descanso.' },
      { name: 'Bloco 4', duration: 120, zone: 3, rpmMin: 75, rpmMax: 85, tip: 'Último bloco.' },
      { name: 'Volta à calma', duration: 300, zone: 1, rpmMin: 45, rpmMax: 55, tip: 'Reduza a carga gradualmente.' },
    ]
  },
  {
    id: 'base_aerobica_30',
    name: 'Base Aeróbica 30',
    category: 'folego',
    description: 'Vinte minutos de Z2 com um trecho de cadência alta no meio. O treino que mais constrói fôlego por hora investida.',
    difficulty: 'Iniciante+',
    focus: 'Base aeróbica',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Deixe a FC subir sem pressa.' },
      { name: 'Base', duration: 480, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Ritmo em que dá para falar frases curtas.' },
      { name: 'Cadência alta', duration: 240, zone: 2, rpmMin: 75, rpmMax: 85, tip: 'Menos carga, pernas mais rápidas, mesma zona.' },
      { name: 'Base', duration: 480, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Volte à cadência normal.' },
      { name: 'Volta à calma', duration: 300, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Reduza a carga gradualmente.' },
    ]
  },
  {
    id: 'base_aerobica_45',
    name: 'Base Aeróbica 45',
    category: 'folego',
    description: 'Trinta e três minutos de Z2 em três blocos. Mais volume na zona que desenvolve o fôlego.',
    difficulty: 'Intermediário',
    focus: 'Base aeróbica',
    phases: [
      { name: 'Aquecimento', duration: 360, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Aqueça devagar.' },
      { name: 'Base', duration: 720, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Ritmo sustentável.' },
      { name: 'Cadência alta', duration: 300, zone: 2, rpmMin: 75, rpmMax: 85, tip: 'Pernas rápidas, mesma zona.' },
      { name: 'Base', duration: 720, zone: 2, rpmMin: 65, rpmMax: 75, tip: 'Segure a zona, não a velocidade.' },
      { name: 'Cadência alta', duration: 300, zone: 2, rpmMin: 75, rpmMax: 85, tip: 'Último trecho rápido.' },
      { name: 'Volta à calma', duration: 300, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Reduza a carga gradualmente.' },
    ]
  },
  {
    id: 'limiar_3x8',
    name: 'Limiar 3×8',
    category: 'folego',
    description: 'Três blocos de oito minutos em Z3. Eleva o ritmo que você aguenta antes de "estourar".',
    difficulty: 'Intermediário',
    focus: 'Limiar',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Carga leve.' },
      { name: 'Ativação', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Z2 para preparar.' },
      { name: 'Bloco 1', duration: 480, zone: 3, rpmMin: 75, rpmMax: 85, tip: 'Z3 constante. Comece contido.' },
      { name: 'Recuperação', duration: 180, zone: 1, rpmMin: 60, rpmMax: 70, tip: 'Alivie a carga.' },
      { name: 'Bloco 2', duration: 480, zone: 3, rpmMin: 75, rpmMax: 85, tip: 'Mesmo ritmo do primeiro.' },
      { name: 'Recuperação', duration: 180, zone: 1, rpmMin: 60, rpmMax: 70, tip: 'Respire fundo.' },
      { name: 'Bloco 3', duration: 480, zone: 3, rpmMin: 75, rpmMax: 85, tip: 'Último bloco.' },
      { name: 'Volta à calma', duration: 360, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Reduza a carga gradualmente.' },
    ]
  },
  {
    id: 'folego_4x4',
    name: 'Fôlego 4×4',
    category: 'folego',
    description: 'Quatro blocos de quatro minutos em Z4 com três de recuperação. Um dos protocolos com mais evidência para aumentar o VO2 máx.',
    difficulty: 'Avançado',
    focus: 'VO2 máx',
    phases: [
      { name: 'Aquecimento', duration: 420, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Aqueça bem.' },
      { name: 'Ativação', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Z2 para preparar.' },
      { name: 'Bloco 1', duration: 240, zone: 4, rpmMin: 80, rpmMax: 95, tip: 'Z4. A FC demora a subir: não exagere no começo.' },
      { name: 'Recuperação', duration: 180, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Recuperação ativa, não pare.' },
      { name: 'Bloco 2', duration: 240, zone: 4, rpmMin: 80, rpmMax: 95, tip: 'Mesmo ritmo do primeiro.' },
      { name: 'Recuperação', duration: 180, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Respire.' },
      { name: 'Bloco 3', duration: 240, zone: 4, rpmMin: 80, rpmMax: 95, tip: 'O mais difícil de segurar.' },
      { name: 'Recuperação', duration: 180, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Último descanso.' },
      { name: 'Bloco 4', duration: 240, zone: 4, rpmMin: 80, rpmMax: 95, tip: 'Último bloco.' },
      { name: 'Volta à calma', duration: 300, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Reduza a carga gradualmente.' },
    ]
  },
  {
    id: 'forca_inicial',
    name: 'Primeira Subida',
    category: 'forca',
    description: 'Três subidas curtas com carga média e cadência baixa, com plano entre elas. Introdução ao treino de força.',
    difficulty: 'Iniciante+',
    focus: 'Força',
    phases: [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Carga leve.' },
      { name: 'Plano', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Ritmo confortável.' },
      { name: 'Subida 1', duration: 240, zone: 2, rpmMin: 60, rpmMax: 70, tip: 'Mais carga, cadência baixa, tronco firme.' },
      { name: 'Plano', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Tire a carga.' },
      { name: 'Subida 2', duration: 240, zone: 3, rpmMin: 60, rpmMax: 70, tip: 'Um pouco mais pesada.' },
      { name: 'Plano', duration: 180, zone: 2, rpmMin: 70, rpmMax: 80, tip: 'Recupere.' },
      { name: 'Subida 3', duration: 180, zone: 3, rpmMin: 55, rpmMax: 65, tip: 'Curta e pesada.' },
      { name: 'Volta à calma', duration: 300, zone: 1, rpmMin: 50, rpmMax: 60, tip: 'Reduza a carga gradualmente.' },
    ]
  },
  {
    id: 'recuperacao_ativa',
    name: 'Recuperação Ativa',
    category: 'recuperacao',
    description: 'Vinte minutos de giro leve em Z1. Ajuda as pernas a se recuperarem de um treino forte sem somar cansaço.',
    difficulty: 'Iniciante',
    focus: 'Recuperação',
    phases: [
      { name: 'Início', duration: 180, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Carga mínima.' },
      { name: 'Giro leve', duration: 900, zone: 1, rpmMin: 70, rpmMax: 85, tip: 'Pernas rápidas e soltas, quase sem carga.' },
      { name: 'Final', duration: 120, zone: 1, rpmMin: 55, rpmMax: 65, tip: 'Desacelere.' },
    ]
  },
];

// ── Storage ──
const CUSTOM_PLANS_KEY = 'spinsync_custom_plans';

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

/** Só os do catálogo — a lista da qual o recomendador escolhe. */
export function getPrebuiltPlans() {
  return PREBUILT_PLANS;
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

/** Categoria de um plano. Personalizados antigos, sem categoria, caem em "Meus". */
export function getPlanCategory(plan) {
  return CATEGORIES.find(c => c.id === plan?.category) || CUSTOM_CATEGORY;
}

/**
 * Quanto do plano é esforço forte. Usado para alternar dias fortes e leves.
 * @returns {{total:number, z3:number, z4plus:number, hard:boolean}} segundos
 */
export function getPlanIntensity(plan) {
  let total = 0, z3 = 0, z4plus = 0, z5 = 0;
  for (const p of plan?.phases || []) {
    total += p.duration;
    if (p.zone === 3) z3 += p.duration;
    if (p.zone >= 4) z4plus += p.duration;
    if (p.zone >= 5) z5 += p.duration;
  }
  // Qualquer trecho em Z5, cinco minutos de Z4+ ou um volume grande de limiar já pedem
  // um dia leve depois. Sprints curtos somam poucos minutos e ainda assim cansam muito.
  return { total, z3, z4plus, hard: z5 > 0 || z4plus >= 300 || z3 >= 1200 };
}

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
 * Target heart-rate window for a phase.
 *
 * Takes a ZoneCalculator rather than a bare maxHR: the zones themselves may be
 * heart-rate-reserve based, and computing the on-screen target as a plain %max would
 * disagree with the zone the recorder reports for the very same beat.
 *
 * @param {object} phase
 * @param {import('./zone-calculator.js').ZoneCalculator} zoneCalc
 */
export function resolvePhaseBPM(phase, zoneCalc) {
  const zone = ZONES.find(z => z.id === phase.zone);
  if (!zone || !zoneCalc) return { min: 0, max: 0 };
  return {
    min: zoneCalc.bpmAt(zone.minPct),
    max: zoneCalc.bpmAt(zone.maxPct)
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
