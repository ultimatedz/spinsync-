# SpinSync

Treino de spinning indoor com frequência cardíaca e cadência em tempo real.

O projeto tem três partes que se conversam:

| Parte | Onde | O que é |
|---|---|---|
| **App** | `index.html`, `css/`, `js/` | PWA em JavaScript puro, sem bundler. Módulos ES nativos. |
| **Wrapper Android** | `android/app/` | Capacitor. Empacota o PWA e dá acesso a BLE nativo e Health Connect. |
| **App do relógio** | `android/wear/` | App Wear OS independente. Lê o sensor do relógio via Health Services e retransmite como um periférico BLE Heart Rate padrão (0x180D) — o celular o enxerga como uma cinta comum. |

## Como montar

```bash
npm install     # roda postinstall: patch-package + vendor:sync + gen-icons
npm run build:web
npx cap sync android
```

`npm install` é obrigatório antes de qualquer build Android — o `postinstall` faz três
coisas sem as quais o app quebra silenciosamente:

1. **`patch-package`** aplica `patches/@capgo+capacitor-health+8.4.8.patch`, que adiciona o
   tipo `WORKOUTS` (`ExerciseSessionRecord`) ao plugin. Sem ele o build Android falha.
2. **`scripts/sync-vendor.mjs`** copia os bundles de `node_modules` para `js/vendor/`. O app
   não tem bundler e carrega esses arquivos direto do `index.html`; sem eles não há BLE,
   nem gráficos, nem Health Connect.
3. **`scripts/gen-icons.mjs`** rasteriza os ícones do PWA em `assets/icons/`.

> `npm ci --ignore-scripts` produz um build Android quebrado. É por isso que este passo
> existe.

`npm run build:web` monta `www/` (o diretório que o Capacitor copia para o APK e que se
publica como PWA) e carimba o `CACHE_NAME` do service worker com um hash do conteúdo — o
service worker é stale-while-revalidate, então sem esse carimbo quem já instalou continuaria
no bundle antigo.

## Rodar

```bash
npm run build:web && npx serve www     # PWA no navegador
npm run cap:open                       # abre o projeto no Android Studio
```

Celular e relógio são módulos Gradle separados:

```bash
cd android
./gradlew :app:assembleDebug     # celular
./gradlew :wear:assembleDebug    # relógio
```

O módulo `wear` tem `build.gradle` próprio (Kotlin 1.9.25, `minSdk 30`) e não herda do
`android/build.gradle` — `cap sync` só reescreve `capacitor.settings.gradle`, então ele
sobrevive aos syncs.

## Desenvolvimento

**Modo demo** — botão na tela inicial. Gera BPM e RPM sintéticos, sem sensor nenhum.

**Relógio sem sensor real** — `USE_FAKE_HEART_RATE = true` em
`android/wear/.../HeartRateSource.kt`. Gera uma rampa 60→180 bpm e um ciclo roteirizado de
disponibilidade (`AVAILABLE` → `ACQUIRING` → `OFF_BODY`), que é a única forma prática de
testar a histerese de contato sem ficar colocando e tirando o relógio.

**Diagnóstico do relógio:**

```bash
adb logcat -s SpinSyncHR:V
```

A cada 15 s sai uma linha com `bpm`, `contact`, `sampleAge`, `state`, `degraded`, `mode` e
`screenOn`. Se aparecer `startExerciseAsync FAILED — degrading to MeasureClient`, falta a
permissão `ACTIVITY_RECOGNITION`: sem ela o Health Services não abre a sessão de exercício e
o sensor para de amostrar com a tela apagada.

## Onde os dados ficam

Tudo em `localStorage` no aparelho. Não há servidor. Desinstalar o app ou limpar os dados
dele apaga o histórico do app.

A cópia de segurança fica fora do app, em **Documentos/SpinSync** (Android 11+): um backup
automático por dia (as 5 cópias mais recentes) mais o que for exportado à mão — backup JSON
e TCX. Esses arquivos sobrevivem à desinstalação e voltam por "Importar backup". No Android
10 ou anterior, onde Documentos exigiria permissão de armazenamento, o backup cai para a
pasta interna do app e o card do perfil avisa que ele não sobrevive à desinstalação. No
navegador (PWA) o export é um download comum.
