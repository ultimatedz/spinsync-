# Auditoria do SpinSync — 18/11/2026

Escopo: app do celular (PWA + Capacitor, `js/`, `index.html`, `css/`, `android/app`), app do
relógio (`android/wear`) e integrações (BLE, Health Connect, foreground services).
Método: leitura integral do código, build dos dois módulos e reprodução no emulador
Android 16 (API 36) dirigido por Chrome DevTools Protocol, com logcat.

---

## 0. Resumo executivo

**O fechamento ao iniciar treino era um crash nativo determinístico, não ANR nem OOM.**
A causa raiz foi reproduzida, corrigida em duas camadas e validada. Na mesma investigação
apareceram e foram corrigidos mais quatro caminhos que tiravam o usuário do app ou o
derrubavam durante o treino.

| # | Achado | Gravidade | Status |
|---|---|---|---|
| 1 | `ForegroundServiceDidNotStartInTimeException` ao iniciar qualquer treino | Crítica | **Corrigido e validado** |
| 2 | Morte do renderer da WebView derrubava o app inteiro no meio do treino | Alta | **Corrigido e validado** |
| 3 | Fim de treino abria a tela de permissões do Health Connect por cima do app | Alta (parece "o app saiu") | **Corrigido e validado** |
| 4 | Service worker fazia o 1º boot após atualizar o APK rodar o JS antigo | Alta (correções chegavam atrasadas) | **Corrigido e validado** |
| 5 | Relógio: mesma corrida stop/start e `startForeground` sem proteção | Alta | **Corrigido** (compila; sem teste em relógio real) |
| 6 | Encerrar o treino com o diálogo de notificação aberto ressuscitava o serviço | Média | **Corrigido e validado** |
| 7 | Pausar o treino corta os pacotes para o relógio; em 15 s ele apaga o treino da tela | Média | **Corrigido e validado** (P1) |
| 8 | Um erro transitório de escrita BLE desliga o espelhamento no relógio até desconectar à mão | Média | **Corrigido e validado** (P1) |
| 9 | `localStorage` com histórico inteiro em um JSON: estoura em ~100 treinos longos | Alta (prazo) | Aberto (P2) |
| 10 | Carga aguda medida na semana de calendário parcial; sono somando 2 noites; `totalCalories` = ativas | Média | **Corrigido e validado** (P1) |
| 11 | "Backup automático" fica na pasta privada do app (some junto ao desinstalar) | Média | **Corrigido e validado** (P1) |
| 12 | Conteúdo rola por baixo da barra de status (edge-to-edge do Android 15+) | Baixa | **Corrigido e validado** (P1) |
| 13 | **"Exportar backup" e "Exportar TCX" não gravavam nada no APK**, mas mostravam "gerado" | Alta | **Corrigido e validado** (P1) |
| 14 | Sessões de segundos contavam para meta, recordes, médias e tentativas da escada | Média | **Corrigido e validado** (P1) |

---

## 1. Crash ao iniciar treino — causa raiz

### 1.1 Evidência

Reproduzido no emulador (Android 16) com o código atual, sem nenhum sensor conectado:

```
W ActivityManager: Bringing down service while still waiting for start foreground:
  ServiceRecord{… com.spinsync.app/.WorkoutForegroundService}
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: android.app.RemoteServiceException$ForegroundServiceDidNotStartInTimeException:
  Context.startForegroundService() did not then call Service.startForeground()
I ActivityManager: Process com.spinsync.app (pid 6731) has died: fg TOP
```

É **crash** (exceção fatal no processo), disparado pelo sistema, sem nenhum frame do app no
stack trace. Por isso ele não aparecia em `console.log` e parecia aleatório.

### 1.2 Mecanismo

1. `startWorkout()` → `startTicking()` chamava **`stopTicking()` primeiro**, para limpar o
   timer anterior.
2. `stopTicking()` também chamava `WorkoutService.stop()`.
3. O plugin implementava `stop` como `startService(ACTION_STOP)`. Com o serviço parado (o
   caso normal no início de um treino), esse intent **criava** o serviço só para ele se
   desligar.
4. Logo em seguida vinha `WorkoutService.start()` → `startForegroundService()`. A partir
   desse instante o Android exige que o serviço chame `startForeground()`.
5. Na thread principal, o `onStartCommand(STOP)` rodava antes e chamava `stopSelf()` **sem
   id**, o que derruba o serviço com o start ainda pendente.
6. O sistema trata isso como promessa de foreground quebrada e mata o processo.

As duas chamadas saem da mesma tarefa JS, quase juntas. A do plugin quase sempre chega ao
ActivityManager antes do `stopSelf()`, então a corrida era perdida em praticamente todo
início. A única exceção era o primeiro treino em Android 13+: lá o diálogo de permissão de
notificação atrasava o start o bastante para o stop terminar antes. O crash surgiu com o
commit `0495fdb` (introdução do foreground service).

### 1.3 Correção (duas camadas, cada uma suficiente sozinha)

| Camada | Arquivo | Mudança |
|---|---|---|
| JS | [js/app.js](../js/app.js) `startTicking` | Usa `clearTickSources()` (só timers); `stopTicking()` fica só para o fim do treino. |
| Serviço | [WorkoutForegroundService.java](../android/app/src/main/java/com/spinsync/app/WorkoutForegroundService.java) | Toda parada pedida pelo app usa `stopSelfResult(startId)`: com um start na fila, a parada é ignorada. Fallback para `dataSync` se `connectedDevice` for recusado. Flag `running` exposta ao plugin. |
| Plugin | [WorkoutServicePlugin.java](../android/app/src/main/java/com/spinsync/app/WorkoutServicePlugin.java) | `stop` não cria serviço quando não há nada rodando. Flag `wanted` impede que o callback do diálogo de permissão ressuscite um treino já encerrado. `handleOnDestroy` para o serviço (antes ficava órfão, com wakelock de 4 h). |

### 1.4 Validação no emulador (API 36)

- Treino livre ×3 e treino guiado: serviço sobe em foreground (`types=0x10`), processo vivo.
- **Stress da sequência antiga**: 20 rodadas de `stop(); start()` coladas, mais 15 de
  `start(); stop()`, direto no plugin. Zero `FATAL` e zero "Bringing down service". O
  estado final sempre segue o último pedido.
- Diálogo de permissão aberto → `stop` → "Permitir": `start` resolve
  `{started:false, reason:'stopped'}` e nenhum serviço fica rodando.

### 1.5 Como confirmar no seu celular

```bash
adb logcat -b crash -d
```

Antes da correção aparece `ForegroundServiceDidNotStartInTimeException`. Depois de instalar
o APK novo não deve aparecer nada ao iniciar treinos. **Atenção:** o primeiro boot após a
instalação ainda roda o JS antigo, servido pelo cache do service worker (item 2.4). O crash
já não acontece nesse boot porque a correção nativa basta sozinha. O JS novo assume a
partir do segundo boot.

---

## 2. Outros cenários de encerramento durante o treino

### 2.1 Morte do renderer da WebView (corrigido)

O Chromium renderiza em outro processo. Com a tela apagada ele perde prioridade e é dos
primeiros a morrer quando falta memória. O Capacitor devolve `false` em
`onRenderProcessGone`, e com isso a WebView **mata o app inteiro**, mesmo com o foreground
service ativo.

Correção em [MainActivity.java](../android/app/src/main/java/com/spinsync/app/MainActivity.java)
(`RendererGuard`): o app responde `true` e recria a Activity. O JS sobe de novo, encontra o
estado salvo a cada 5 s e abre o modal de recuperação. Há proteção contra laço: se o
renderer morrer de novo em menos de 15 s, a Activity encerra.
**Validado:** com `Page.crash` no meio do treino guiado, o processo sobreviveu, o modal
apareceu ("Subida Simulada") e a retomada religou o foreground service. Perda máxima: os
últimos 5 s antes do crash.

### 2.2 Health Connect abrindo por cima do resumo (corrigido)

`syncWorkout()` chamava `requestAuth()` a cada fim de treino. O pedido inclui permissões
de **leitura** (HRV, FC de repouso, sono) que o sync nem usa, então bastava faltar uma
delas para a tela do Health Connect abrir logo depois de "Finalizar". Observado no
emulador.
Correção em [js/health-sync.js](../js/health-sync.js): o sync só **consulta**
(`checkAuthorization`) e grava apenas os tipos concedidos. Sem nenhuma permissão, retorna
`skipped` e não mostra toast de erro. Pedir permissão continua sendo pelo card do perfil.

### 2.3 Relógio (corrigido, sem teste em hardware)

[HrBroadcastService.kt](../android/wear/src/main/java/com/spinsync/wear/HrBroadcastService.kt):
- `ACTION_STOP` usava `stopSelf()` puro: mesma corrida do celular ao tocar Parar e Transmitir
  em sequência, ou ao usar o tile → agora usa `stopSelf(startId)`.
- `startForeground(type=health)` não tinha proteção. Se a permissão de sensor tiver sido
  revogada, ou se o `START_STICKY` ressuscitar o serviço em segundo plano, ele lança
  `SecurityException` e o app do relógio fecha → agora mostra "Permissão negada" e para.

### 2.4 Service worker dentro do APK (corrigido)

O SW é stale-while-revalidate: serve primeiro o cache e atualiza depois. Dentro do APK os
arquivos já são locais, então ele não traz nada offline e faz **o primeiro boot após cada
atualização rodar o bundle anterior**. Isso foi medido: o JS novo só entrou no segundo boot.
[js/app.js](../js/app.js) `setupServiceWorker()` agora registra o SW só no PWA e, no
nativo, remove registros e caches antigos. Validado: no 3º boot não há SW nem cache, e
dali em diante as atualizações valem já no primeiro boot.

### 2.5 Riscos remanescentes (não corrigidos)

| Cenário | Risco | Recomendação |
|---|---|---|
| Otimização de bateria da Samsung ("apps em suspensão profunda") | Pode matar o app mesmo com o foreground service ativo | Detectar `isIgnoringBatteryOptimizations` e mostrar um atalho para os ajustes, com explicação. Pedir isenção direta pode esbarrar na política da Play Store. |
| Treino com mais de 4 h | O wakelock expira (o serviço segue) | Aceitável. Documentar. |
| `dataSync` no Android 15+ | Limite de 6 h/dia. `onTimeout` já para o serviço de forma limpa. | Só ocorre sem `BLUETOOTH_CONNECT`. Aceitável. |
| Sem log local de erros | Falhas do JS somem no console | Ring buffer de erros (`window.onerror` + `unhandledrejection`) e botão "Exportar diagnóstico". Para crashes nativos, Crashlytics ou equivalente. |
| Relógio: `endExerciseAsync` antigo vs. `startExerciseAsync` novo num toggle rápido | O fim da sessão velha pode encerrar a nova | Serializar stop→start em um `Mutex` no `ExerciseHeartRateSource`. |

---

## 3. Auditoria geral

### 3.1 O que está bem feito

O código é cuidadoso e bem comentado. Vários problemas clássicos já foram resolvidos com
critério:
- Tempo por relógio de parede e créditos ponderados por `dtMs` (sobrevive ao throttling da
  WebView).
- Amostra velha conta como esforço desconhecido, não como esforço zero.
- Heartbeat nativo independente dos timers do renderer.
- Histerese de contato do sensor no relógio, separando `ACQUIRING` de `OFF_BODY`.
- `ExerciseClient` em vez de `MeasureClient` (que para de amostrar com a tela apagada no Watch 4).
- Recuperação de sessão, leitura de storage tolerante a corrupção, snapshot de FC máx/repouso por treino.
- Motor de progressão que se recusa a promover sem FC.

### 3.2 Bugs funcionais encontrados

> Atualização: todos os itens desta tabela, exceto a dizimação (P2) e as médias da volta,
> foram corrigidos na rodada P1 — ver seção 8.

| Onde | Problema | Efeito |
|---|---|---|
| [js/app.js:2495](../js/app.js) e `workoutTick` | Com o treino pausado, `tick()` devolve `null` e `mirrorToWatch()` nunca roda | O relógio nunca mostra "Treino pausado" (a string existe e não é alcançável). Após 15 s ele expira o treino e volta à tela ociosa. |
| [js/ble-manager.js:338](../js/ble-manager.js) | Qualquer falha de escrita marca `_workoutUnsupported = true` para sempre, e `_attach` na reconexão não reseta | Uma falha transitória no meio do treino desliga o espelhamento até desconectar manualmente |
| [js/app.js:2002](../js/app.js) | A dizimação para 500 pontos mantém o `dtMs` original de cada ponto | Toda métrica absoluta ponderada por tempo, calculada sobre o treino salvo (TRIMP, HRR), sai subestimada pelo fator de dizimação. Hoje só razões usam esses dados, então ainda não aparece. Vai aparecer ao implementar a seção 4. |
| [js/analytics.js:230](../js/analytics.js) | Carga "aguda" = semana de calendário até agora | Toda segunda-feira a razão aguda:crônica despenca ("pode ser perda de ritmo") e só fica justa no domingo. Precisa de janela móvel de 7 dias. |
| [js/health-sync.js:266](../js/health-sync.js) | Sono = soma de todas as sessões das últimas 48 h | Soma ~2 noites (≈14 h), então "sono curto" praticamente nunca dispara |
| [js/health-sync.js](../js/health-sync.js) | `totalCalories` gravado com o valor de calorias **ativas** | Total deveria ser ativo + basal no intervalo. Do jeito atual, subnotifica o total e confunde quem soma os dois. |
| [js/analytics.js:107](../js/analytics.js) | Sessões de poucos segundos contam como treino | Visto no emulador: "Meta da semana batida — 8 de 3" com 8 sessões de 4–25 s; Resultados mostra 8 treinos e 0h 0m |
| [js/auto-backup.js:72](../js/auto-backup.js) | Backup em `Directory.Data` (pasta privada do app) | Protege contra corrupção do `localStorage`, mas some junto ao desinstalar ou limpar dados, que são justamente os cenários do README |
| `workout-recorder.js` `markLap` | Médias da volta por amostra, sem peso de tempo | Inconsistente com o resto, que pondera por `dtMs`. Pequeno. |

### 3.3 Funcionalidades importantes que faltam

- Recomendação do treino do dia (hoje só existe o próximo degrau da escada).
- Carga por FC (TRIMP), forma/fadiga (CTL/ATL/TSB), distribuição de intensidade.
- Controle do treino pelo relógio (pausar, volta, pular fase).
- Gravação local no relógio com sincronização posterior.
- Resumo e histórico no relógio.
- Dicas por voz (TTS) nos treinos guiados. No spinning é o canal que funciona: não dá para
  olhar a tela no sprint.
- Intervalos R-R das cintas (o parser ignora o bit 4 do 0x2A37).
- Potência (Cycling Power 0x1818 / FTMS 0x1826) para quem tem bike smart ou medidor.
- Teste de FC máxima guiado e autocalibração (sugerir atualizar o perfil quando a FC
  observada passa da máxima configurada).
- Leitura de outras atividades do Health Connect (musculação, corrida) para a carga total.

### 3.4 Arquitetura e qualidade de código

- **`js/app.js` tem 3.200 linhas numa classe só** (views, BLE, gravação, guiado, persistência,
  criador de planos). Proposta: `WorkoutSession` (máquina de estados: idle → running ⇄
  paused → finished), um módulo por tela e serviços (`ble`, `storage`, `watch-link`).
- **Zero testes** (`npm test` é um stub). `progression`, `analytics`, `workout-recorder`,
  `hr-parser`, `cadence-parser` e `zone-calculator` são quase puros, ideais para `node:test`
  sem dependência nova. O histórico tem commits como "quatro regressões minhas": testes
  pagariam rápido.
- **Armazenamento**: todo o histórico é um array JSON no `localStorage`. Um ponto de dados
  tem ~100 bytes e um treino salvo até 500 pontos (~50 KB). Com o teto de ~5 MB por origem,
  o armazenamento cheio chega por volta de **100 treinos longos**, uns 6 a 8 meses a 3–4
  treinos por semana. Daí em diante o fallback salva os treinos sem gráficos. Além disso,
  cada render da home faz 4–5 `JSON.parse` do histórico inteiro, e o coach reavalia todas
  as sessões da escada. Proposta: IndexedDB (ou SQLite via Capacitor), com resumo e
  amostras em stores separados, e índices por data/plano.
- **CSS** de 2.542 linhas com blocos de override no fim (ex.: `:root` redefinido na linha
  2003). Consolidar tokens e remover overrides.

### 3.5 Desempenho e bateria (celular)

| Item | Avaliação |
|---|---|
| Tick 1 Hz + heartbeat nativo deduplicado | Bom |
| Wakelock parcial (4 h) + `navigator.wakeLock('screen')` | A tela fica acesa o treino todo. É o maior consumo. Oferecer "Manter tela ligada: sempre / só no guiado / nunca". |
| Escrita BLE 1×/s para o relógio | Barata (`writeWithoutResponse`, 11 bytes) |
| Backup automático no boot | Serializa o histórico inteiro pela ponte do Capacitor a cada boot (MBs com o tempo), e o build debug imprime o JSON inteiro no logcat. Fazer incremental, fora do caminho do boot. |
| Health Connect: 60 `saveSample` de FC sequenciais | 60 idas e voltas por IPC; o ideal é um `HeartRateRecord` com série. É limitação do plugin: vale estender o patch. |

### 3.6 Tratamento de erros e estados

Bons: tela de erro de boot, estados de sensor detalhados (`bt-off`, `timeout`, `stale`),
toasts para armazenamento cheio, modal de recuperação.
Faltam: log local de erros, estado vazio no relógio quando o celular some, mensagem quando
o Health Connect não tem HRV/FC de repouso (o card de prontidão só some, sem explicar).
Também falta aviso de "treino curto demais, descartar?".

### 3.7 Integração celular ↔ relógio

O desenho é bom: o relógio vira uma cinta BLE padrão (0x180D), funciona com qualquer app e
recebe o estado do treino por uma característica proprietária. Funciona com o celular
bloqueado (foreground service + heartbeat nativo). Limitações:
- **Unidirecional**: o relógio não comanda nada.
- **Sem buffer**: se o link cai, a FC daquele trecho se perde. Esse tempo vira
  "unclassified" no celular.
- Pausa invisível e espelhamento que desliga para sempre (ver 3.2).

---

## 4. Inteligência de treinamento

### 4.1 Princípio: três coisas diferentes, três medidas diferentes

| Dimensão | O que mede | Fonte confiável | Fonte que **não** serve sozinha |
|---|---|---|---|
| **Esforço cardiovascular** | Quanto o sistema cardiorrespiratório trabalhou | FC × tempo (TRIMP), tempo em zona | Calorias (estimativa de ±20–30%) |
| **Carga muscular/neuromuscular** | Quanto as pernas trabalharam: força, sprints, fadiga periférica | Potência/torque, sRPE, tipo de fase (sprint, subida), resistência usada | **FC.** Num Tabata a FC mal reage em 20 s e a carga muscular é enorme. Numa subida pesada a 55 rpm a FC sobe pouco e as pernas pagam caro. |
| **Recuperação** | Se o corpo absorveu a carga | HRV (lnRMSSD) e FC de repouso vs. linha de base pessoal, sono, questionário subjetivo | Um valor isolado de HRV (varia demais entre pessoas e de dia para dia) |

A FC é ótima para a primeira dimensão, fraca para a segunda e indireta para a terceira. Por
isso o motor tem que **cruzar** sinais e mostrar de onde veio cada conclusão.

### 4.2 O que já existe e pode ser aproveitado

Por treino: `zoneTime` (preciso, vem dos acumuladores), `avgBPM`/`maxBPM`, `dataPoints`
(bpm, rpm, zona, `dtMs`), voltas, RPE (opcional), FC máx/repouso do dia, `planId`, distância.
Por dia (Health Connect, se a fonte escrever): HRV, FC de repouso, sono.
Motor: escada com avaliação por aderência (`progression.js`), sRPE e razão aguda:crônica
(`analytics.js`), tendência de FC no mesmo plano.

### 4.3 Camada 1 — métricas por sessão (todas calculáveis hoje)

| Métrica | Fórmula | Observação |
|---|---|---|
| **TRIMP de Edwards** | Σ minutos na zona *z* × *z* (z = 1…5) | Sai direto de `zoneTime`, exato e já disponível em todo o histórico |
| **TRIMP de Banister** | Σ Δt(min) × FCr × 0,64·e^(1,92·FCr) (homens) ou 0,86·e^(1,67·FCr) (mulheres), com FCr = (FC − FCrep)/(FCmáx − FCrep) | Precisa da série. Corrigir a dizimação antes (somar `dtMs` dos pontos fundidos) ou calcular antes de salvar. |
| **sRPE** | minutos × RPE | Já existe. É a melhor medida única de carga **total** (cardio + muscular). Tornar o RPE proeminente no resumo. |
| **Distribuição de intensidade** | % do tempo em Z1–2 / Z3 / Z4–5 | Modelo de 3 zonas: mostra se a semana está polarizada (~80/20) ou presa no "meio-termo" |
| **FC de recuperação (HRR60)** | FC no fim do último esforço − FC 60 s depois | Calcular com os pontos a 1 Hz **antes** de salvar. Os guiados já marcam onde o esforço acaba. Usar como tendência pessoal, nunca como diagnóstico. |
| **Deriva cardíaca** | (FC média da 2ª metade − 1ª metade) / 1ª metade, só em fases Z2 de 10+ min com cadência estável (±5 rpm) | Sem potência é aproximação. Rotular assim. >5% sugere base aeróbica a construir, calor, desidratação ou fadiga. |
| **Pico de FC vs. FC máx do perfil** | FC máx observada (sustentada 5+ s) > configurada | Sugerir atualizar o perfil (autocalibração das zonas) |
| **Carga "de força"** | Tempo em fases tipo subida (cadência ≤ 65 com zona ≥ 3) e sprint | Proxy enquanto não há potência. Marcar o tipo de fase nos planos. |

### 4.4 Camada 2 — estado do atleta (tendências)

| Indicador | Cálculo | Uso |
|---|---|---|
| **Condicionamento (CTL)** | Média exponencial de 42 dias da carga diária (TRIMP) | "Forma de base" — sobe devagar |
| **Fadiga (ATL)** | Média exponencial de 7 dias | Sobe e desce rápido |
| **Forma (TSB)** | CTL de ontem − ATL de ontem | Negativa = carregado. Muito positiva por muito tempo = destreinando. |
| **Variação de carga** | 7 dias móveis ÷ média dos 28 anteriores (ou razão de EWMAs) | Substitui a semana de calendário. Comunicar como "salto de volume", não como risco de lesão: a evidência de previsão de lesão pela razão aguda:crônica é contestada. |
| **Monotonia e strain (Foster)** | média ÷ desvio-padrão da carga diária em 7 dias; strain = carga semanal × monotonia | Semana com dias todos iguais e pesados (monotonia > 2) é o padrão de sobrecarga |
| **Consistência** | Sessões/semana, dias desde o último treino, sequência de semanas (já existe) | Base da recomendação de volume |
| **Prontidão** | lnRMSSD média de 7 dias vs. base de 30–60 dias ± SWC (0,5 × DP); FC de repouso 7 dias vs. base; sono **da última noite** | Substitui os limiares fixos de 10%/20% atuais |

### 4.5 Camada 3 — recomendação do próximo treino (regras explicáveis)

Regras determinísticas, não aprendizado de máquina. São auditáveis, funcionam com poucos
dados, e cada sugestão vem com o "porquê", como o veredito atual já faz.

| Condição (avaliada nesta ordem) | Sugestão |
|---|---|
| Prontidão vermelha (lnRMSSD abaixo da faixa **e** FC de repouso +5 bpm, ou sono < 5 h) **ou** TSB < −30 | Descanso, ou 20–30 min em Z1 |
| Dor muscular informada ≥ 6/10 **ou** sessão de força/sprint nas últimas 48 h | Endurance Z2, sem intervalos e sem subida (protege as pernas sem parar o cardio) |
| Sessão de Z4+ (≥ 8 min) ou RPE ≥ 7 nas últimas 48 h | Z2 contínuo (base da polarização) |
| TSB entre −10 e +10, prontidão verde, ≥ 48 h desde o último esforço forte | Próximo degrau da escada ou intervalado |
| Variação de carga > 1,3 | Manter o volume da semana; não subir |
| TSB > +15 há 7+ dias | Aumentar volume (+10–15% de minutos na semana) |
| Dois vereditos "advance" seguidos em plano personalizado | Progressão automática: +1 intervalo, ou +10% na duração das fases fortes |

Limites de progressão: subir o volume semanal no máximo 10–15% e a intensidade de cada
vez. Isso já é o espírito da escada atual.

### 4.6 Relatórios propostos

- **Gráfico de forma** (CTL/ATL/TSB) dos últimos 90 dias.
- **Carga semanal** em barras empilhadas por zona (mostra volume e distribuição de uma vez).
- **Calendário de consistência** (heatmap por dia, cor = carga).
- **Tendência cardiovascular**: FC média no mesmo plano (já existe) + HRR60 + deriva em Z2.
- **Recuperação**: FC de repouso e HRV com a faixa pessoal sombreada.
- Recordes (já existe).

### 4.7 Dados adicionais para recomendações confiáveis

| Dado | Como coletar | O que destrava |
|---|---|---|
| **RPE em todo treino** | Pergunta grande no topo do resumo, com lembrete se ficar vazio | sRPE confiável, o único proxy decente de carga muscular sem potência |
| **Dor muscular / pernas (0–10)** e bem-estar (sono, estresse, humor) | 3 toques antes de iniciar, ou na home de manhã | Separar fadiga muscular de cardiovascular |
| **Resistência usada por fase** (botão da bike, 1–10) | Coroa/botão no relógio ou chip na tela do guiado | Carga de força sem medidor de potência |
| **Intervalos R-R** de cintas peitorais | Parsear o bit 4 do 0x2A37 em `hr-parser.js` | HRV no treino (DFA α1 para limiar aeróbico) e teste matinal de HRV |
| **Teste matinal de 2 min** (cinta, deitado) | Tela dedicada | Prontidão padronizada, independente do Samsung Health |
| **Potência** | BLE Cycling Power (0x1818) / FTMS (0x1826) | kJ, TSS, teste de FTP, carga muscular objetiva, deriva Pa:FC |
| **Outras atividades** | Health Connect `ExerciseSession` (o manifesto já declara leitura) | Carga total, mais "fez perna na academia ontem" (precisa de etiqueta do usuário: o HC não informa o grupo muscular) |
| **FC máx medida** | Teste guiado (rampa ou 3×3 min) | Zonas corretas. Tanaka tem DP de ~10 bpm. |

> Confira no app Health Connect se o Samsung Health está escrevendo **HRV** e **FC de
> repouso**. Se não estiver, o card de prontidão nunca aparece. O teste matinal com cinta
> resolve isso sem depender da Samsung.

### 4.8 Ordem de implementação sugerida

1. Corrigir a dizimação, a janela móvel de 7 dias e o sono da última noite (pré-requisitos).
2. TRIMP de Edwards (retroativo em todo o histórico) e distribuição de intensidade.
3. CTL/ATL/TSB e o card "Hoje" com a recomendação + "por quê".
4. RPE obrigatório-suave, questionário de pernas, HRR60.
5. R-R, teste matinal, potência.

---

## 5. Galaxy Watch 4

### 5.1 Limites do hardware e do sistema

- Bateria de 247 mAh (40 mm) / 361 mAh (44 mm), Exynos W920, 1,5 GB de RAM. Tela sempre
  acesa é o maior consumo.
- Sensor óptico (BioActive): bom em ritmo estável e com atraso em mudanças bruscas. O
  pulso flexionado no guidão piora o contato (o código já trata o re-lock).
- Health Services: uma sessão de exercício por vez no sistema inteiro. O Samsung Health
  toma a sessão (o app já cai para o `MeasureClient` e avisa). **Não expõe R-R a apps de
  terceiros.** O Samsung Health Sensor SDK expõe IBI no Watch 4, mas exige modo
  desenvolvedor para uso pessoal e parceria com a Samsung para distribuir.
- Ambient: medido no próprio código, o Watch 4 para a janela de apps de terceiros e mostra
  o mostrador. Por isso existe a Ongoing Activity.
- O código já trata API 30–36 (`BODY_SENSORS` vs. `health.READ_HEART_RATE`), então serve
  qualquer versão de Wear OS que o seu Watch 4 esteja rodando.

### 5.2 Avaliação item a item

| Item | Situação | Ação |
|---|---|---|
| FC em tempo real | Boa (sessão `BIKING_STATIONARY`, push imediato a cada amostra) | — |
| Legibilidade | BPM em 36 sp; tempo e kcal em 15 sp; próxima fase em 13 sp | Modo treino com BPM em 54–60 sp, zona como anel (já existe) e **um** dado secundário grande que alterna a cada toque |
| Confiabilidade | Histerese de contato correta; keepalive; watchdog de pacote de treino (15 s) | Corrigir a pausa invisível e o espelhamento que desliga (3.2) |
| Bateria | `FLAG_KEEP_SCREEN_ON` o treino todo + wakelock | Opção "Economia": tela apaga e a FC segue pela Ongoing Activity; brilho mínimo no modo treino |
| Celular bloqueado | Funciona (foreground service + heartbeat nativo) | — |
| Celular distante/desconectado | O relógio segue medindo, mas **descarta** | Buffer local (FC + timestamp) e backfill por característica de leitura em lotes, ou Wearable Data Layer (o `applicationId` já é o mesmo) |
| Continuidade | O relógio volta a transmitir ao reconectar; o celular reconecta com backoff | Com buffer, o treino fica contínuo de verdade |
| Alertas | Desvio de zona por 25 s com cooldown de 60 s; hápticos de fase | Alerta de teto (FC > 95% da máx); resumo de fase por háptico |
| Controle | Nenhum | Característica *notify* do relógio para o celular: pausar/retomar, volta, pular fase |
| Resumo ao fim | Nenhum (a tela só limpa) | Pacote de "fim de treino" com duração, FC média/máx, tempo por zona e kcal, mostrado por 30 s |
| Histórico no relógio | Nenhum | Últimos 10 resumos em DataStore. Barato e viável. |
| Tile | Iniciar/parar + BPM | Mostrar o treino do dia recomendado |

### 5.3 Viabilidade

Viável sem mudar a arquitetura: modo treino legível, pausa visível, controle por
característica BLE, resumo final, histórico local, buffer com backfill, alerta de teto, modo
economia.
Viável com custo: Wearable Data Layer (exige Play Services nos dois lados e a mesma
assinatura), gravação 100% autônoma no relógio (vira um segundo app de treino).
Não viável no Watch 4 para apps comuns: R-R/HRV pelo Health Services, potência.

---

## 6. UX/UI — tela por tela

Achados visuais confirmados por captura no emulador (1080×2400).

### Transversais

- **Emojis como ícones** (🏠📋📈👤❤️⚙️🔥🌱): renderizam diferente em Samsung e Google e dão
  aspecto amador → um conjunto de ícones SVG inline (Lucide ou Material Symbols),
  monocromático e consistente com o relógio.
- **Edge-to-edge** (Android 15+, `targetSdk 36`): o conteúdo rolado passa por baixo da
  barra de status, e o banner de demo sobrepõe relógio e ícones → usar as variáveis
  `--safe-area-inset-*` que o `SystemBars` do Capacitor 8 injeta (o CSS usa só `env()`) e
  um *scrim* fixo no topo.
- "Queima de Gordura" para Z2 é um rótulo de marketing → "Base aeróbica" (Z2) e "Limiar"
  (Z4). Mantém as cores.

### Início — **redesenhar**

Hoje o primeiro terço é logo + nome do app, e **"Iniciar treino livre" só aparece depois de
rolar** (sensores, filtros e carrossel vêm antes). Proposta, de cima para baixo:
1. Linha de sensores compacta: chips `♥ 72 bpm` / `⟳ cadência`, toque para conectar.
2. Card **Hoje**: recomendação ("Z2 contínuo 40 min — você fez Tabata ontem") com CTA
   primário "Iniciar" e secundário "Treino livre".
3. Card **Semana**: anel da meta + carga + sequência (funde meta e coach).
4. Planos (carrossel) e "Criar treino".
Remover o hero do logo.

### Treino livre — **reorganizar**

Muito espaço vazio entre o cronômetro, o círculo e o gráfico. Cronômetro cinza-claro de
baixo contraste. Gráfico em tempo real sem legenda nem eixos (qual linha é FC e qual é
cadência?). Proposta: cronômetro em contraste total, FC dominante com a zona como faixa de
5 segmentos, grade 2×2 (cadência, kcal, FC média, tempo na zona atual), gráfico legendado e
maior. Layout paisagem para suporte de guidão. Modo "bloquear toques" contra encostos
acidentais.

### Treino guiado — **ajustar**

"Alvo: 55-65" quebra em duas linhas dentro do card de cadência (bug de layout), e o card de
calorias fica com um vazio grande. Falta o tempo total restante (só há uma barra fina sem
rótulo). Proposta: medidor de alvo visual (faixa alvo + marcador da FC atual) em vez do
selo "QUASE"; "Faltam 18:40" junto da barra total; **contagem por voz** nas trocas de fase
("Sprint em 5… 4…").

### Resumo — **reorganizar**

Bom no topo. Proposta: RPE **no topo** (alimenta a carga), barra de distribuição por zona
logo abaixo dos números, carga/TRIMP e HRR60, comparação com a última vez no mesmo plano. O
veredito do coach acima dos gráficos. Oferecer descarte para sessões com menos de 2 min.

### Histórico — **simplificar**

A lista funciona. Faltam agrupamento por semana com total de carga e filtro por plano/mês.
Avaliar fundir com Resultados (duas abas para olhar o passado).

### Resultados — **redesenhar**

Hoje são quatro números + calorias por dia, a métrica menos útil para treino. Proposta, em
ordem: gráfico de forma (CTL/ATL/TSB), carga semanal empilhada por zona, calendário de
consistência, tendência cardiovascular, recuperação, recordes. Calorias como detalhe.

### Perfil — **dividir**

Formulário longo que mistura fisiologia, sensores, roda, hápticos, auto-pausa, Health
Connect, backup, demo e escada. Separar em **Perfil** (dados fisiológicos + prévia das
zonas, que já é ótima) e **Ajustes**.

### Relógio — **modo treino**

Ver 5.2. Durante o treino o relógio deve mostrar menos coisas, maiores. A cor da zona já é
consistente com o celular (mesma paleta). Manter assim.

---

## 7. Roadmap priorizado

**P0 — estabilidade (feito nesta sessão):** itens 1–6 da tabela do resumo.

**P1 — correções baratas de alto impacto (feito — ver seção 8)**
- ~~Pausa visível no relógio~~ · ~~espelhamento BLE resiliente~~ · ~~janela móvel de 7 dias,
  sono da última noite, `totalCalories`~~ · ~~sessões com menos de 2 min~~ · ~~backup e
  exports em Documentos~~ · ~~safe-area e quebra do "Alvo"~~.
- Restante: compartilhar o TCX direto pela folha de compartilhamento do Android
  (`@capacitor/share`), em vez de só salvar em Documentos.

**P2 — fundações**
- IndexedDB com resumo e amostras separados; dizimação por agregação.
- Testes `node:test` dos módulos puros.
- Quebrar `app.js` em sessão + telas.
- Log local de erros + "Exportar diagnóstico".

**P3 — inteligência e relógio**
- TRIMP, distribuição, CTL/ATL/TSB, card Hoje com recomendação explicada.
- RPE/pernas/bem-estar; HRR60; R-R.
- Relógio: modo treino, controle, resumo, histórico, buffer com backfill.
- Redesenho da Início e de Resultados; voz nos guiados.

---

## 8. Rodada P1 — o que mudou e como foi validado

| Item | Mudança | Validação |
|---|---|---|
| Pausa no relógio | `workoutTick`/`guidedTick` espelham também pausados; `setPauseButton` força o envio na hora; limite de ~1 Hz porque as duas fontes de tick chegam sem a deduplicação do recorder | Emulador: 1º pacote 1 ms após o toque, ~1/s durante a pausa, todos com `paused`, tempo congelado |
| Espelhamento BLE | `_writeToWatch` com política única: "not found"/`NotFoundError` desliga na hora (cinta comum); outras falhas só após 5 seguidas; zera a cada `_attach` (inclusive reconexão automática). Mesmo contrato no Web Bluetooth. | Node: falha passageira ×3 → volta; ×5 → desliga; cinta comum → 1 tentativa; háptico e treino independentes |
| Carga | `computeTrainingLoad(workouts, now)`: janelas móveis de 7 dias. Textos e rótulos ("últimos 7 dias") e "salto de volume" em vez de risco de lesão. | Node: segunda-feira às 8h com 3×/semana → razão ≈ 1 (antes ≈ 0); salto real → ≥ 1,5 |
| Sono | `sleepHoursLast24h`: só as últimas 24 h, com intervalos unidos (duas fontes não dobram); sem dado → `null`, não "0 h" | Node: duas noites → 6 h; duplicata sobreposta → 6,3 h |
| Calorias totais | `restingKcal` (Mifflin, a mesma do app) somado às ativas | Node: 80 kg/180 cm/35 a, 45 min → 54,8 kcal basais |
| Sessões curtas | `Storage.countsAsTraining` (< 120 s fica fora de estatística, meta, recordes e escada); ao encerrar, modal "Treino muito curto" com Guardar/Descartar | Node + emulador: descartar não grava e limpa o estado de recuperação; guardar grava e não conta |
| Backup e exports | `AutoBackup.writeUserFile`: Documentos/SpinSync, reserva na pasta interna; rodízio só dos automáticos; card diz onde ficou e que é visível a apps com acesso a arquivos. Exportar JSON/TCX passam pelo mesmo caminho no APK. | Emulador: os três arquivos em `/sdcard/Documents/SpinSync/`; TCX é XML válido. Antes: toast de sucesso e nenhum arquivo. |
| Safe-area | Faixa opaca atrás da barra de status; banner de demo das telas de treino assume o inset | Captura: conteúdo rolado não passa mais sob o relógio; banner abaixo da barra |
| "Alvo" no guiado | `flex-wrap` na linha e `nowrap` no rótulo | Captura: "Alvo: 55-65" numa linha, selo abaixo |

Regressão de estabilidade repetida no build final: 3 treinos livres, 20 sequências
stop/start, treino guiado e crash do renderer — zero `FATAL`, zero "Bringing down
service", nenhuma tela do Health Connect.

Não validado: sobrevivência dos arquivos a uma desinstalação real (não desinstalei para
não apagar os dados que já estavam no emulador; é o comportamento padrão do Android para
`Documents`), e nada disso em celular ou relógio físicos.

## Anexo A — arquivos alterados nesta sessão

- `android/app/src/main/java/com/spinsync/app/WorkoutForegroundService.java`
- `android/app/src/main/java/com/spinsync/app/WorkoutServicePlugin.java`
- `android/app/src/main/java/com/spinsync/app/MainActivity.java`
- `android/wear/src/main/java/com/spinsync/wear/HrBroadcastService.kt`
- `js/app.js` (`startTicking`/`clearTickSources`, `setupServiceWorker`, toast do sync; P1:
  pausa espelhada, `concludeSession`, `saveFile`, card de backup, textos da carga)
- `js/health-sync.js` (`grantedWriteTypes`, sync sem pedir permissão; P1: `sleepHoursLast24h`,
  `totalCalories`)
- P1: `js/ble-manager.js`, `js/analytics.js`, `js/storage.js`, `js/progression.js`,
  `js/calorie-calculator.js`, `js/auto-backup.js`, `css/styles.css`, `index.html`, `README.md`

## Anexo B — como reproduzir o crash original

1. Checkout de `9d199e2`, build e instalação no emulador API 34+ com `POST_NOTIFICATIONS` concedida.
2. Iniciar qualquer treino.
3. `adb logcat -b crash -d` mostra `ForegroundServiceDidNotStartInTimeException`.
