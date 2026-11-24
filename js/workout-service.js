/**
 * Foreground service do treino, no Android.
 *
 * Mantém o processo vivo com a tela apagada e fornece um heartbeat nativo de 1 Hz. O
 * heartbeat existe porque o serviço sozinho não basta: o Chromium desacelera os timers de
 * uma WebView não visível até uma acordada por minuto, e isso é política do renderer, não
 * do Android. Uma chamada originada no nativo não passa por esse acelerador.
 *
 * No navegador vira no-op — a checagem é de plataforma nativa, e não de existência do
 * plugin, para que um build web quebrado não seja engolido em silêncio.
 */

const native = window.Capacitor?.isNativePlatform?.()
  ? window.Capacitor.registerPlugin('WorkoutService')
  : null;

export function isAvailable() {
  return !!native;
}

/** Nunca lança: uma falha aqui não pode abortar o início do treino. */
export async function start(title) {
  if (!native) return false;
  try {
    const res = await native.start({ title });
    if (!res?.started) console.warn('[FGS] não iniciou:', res?.reason);
    return !!res?.started;
  } catch (e) {
    console.warn('[FGS] start falhou:', e?.message);
    return false;
  }
}

export async function stop() {
  if (!native) return;
  try {
    await native.stop();
  } catch (e) {
    console.warn('[FGS] stop falhou:', e?.message);
  }
}

/** Texto da notificação persistente. O nativo já limita a taxa de renotificação. */
export async function update(title, text) {
  if (!native) return;
  try {
    await native.update({ title, text });
  } catch (e) {
    /* nada a fazer — a notificação é informativa */
  }
}

/**
 * Assina o heartbeat nativo.
 * @returns {Function} remove a assinatura.
 */
export function onTick(fn) {
  if (!native) return () => {};
  const handle = native.addListener('tick', fn);
  return () => { handle.then(h => h.remove()).catch(() => {}); };
}
