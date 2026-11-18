package com.spinsync.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Ponte JS ↔ foreground service do treino, mais o heartbeat que mantém o tick vivo.
 *
 * O heartbeat existe porque o foreground service sozinho NÃO resolve o problema. São dois
 * mecanismos independentes matando o loop de gravação:
 *
 *  1. o Android congela o processo em cache — isto o serviço resolve;
 *  2. o Chromium desacelera os timers de uma WebView não visível até uma acordada por
 *     minuto — isto o serviço não afeta, é política do renderer.
 *
 * A chamada abaixo parte do nativo e chega ao JS por evaluateJavascript, exatamente o mesmo
 * caminho pelo qual as notificações BLE já chegam com a tela apagada. Por não ser um timer
 * do renderer, não é desacelerada.
 *
 * O Handler vive aqui e não no serviço para o serviço ter uma responsabilidade só e não
 * precisar de callback estático entre Service e Plugin.
 */
@CapacitorPlugin(
    name = "WorkoutService",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class WorkoutServicePlugin extends Plugin {

    private static final String TAG = "SpinSync";
    private static final long HEARTBEAT_MS = 1000;
    /** Log de baixa taxa: uma parada com a tela apagada tem que ser visível no logcat. */
    private static final long DIAG_MS = 15_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean running = false;
    private long lastDiagAt = 0;
    private long ticks = 0;

    /**
     * O que o JS pediu por último: start (true) ou stop (false).
     *
     * O start pode ficar suspenso no diálogo de permissão de notificação; se o treino for
     * encerrado nesse meio-tempo, o callback não pode ressuscitar o serviço de uma sessão
     * que já acabou — ele ficaria segurando a CPU acordada por horas.
     */
    private volatile boolean wanted = false;

    private final Runnable heartbeat = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            ticks++;
            notifyListeners("tick", new JSObject().put("at", System.currentTimeMillis()));

            long now = SystemClock.elapsedRealtime();
            if (now - lastDiagAt >= DIAG_MS) {
                lastDiagAt = now;
                Log.i(TAG, "workout heartbeat ticks=" + ticks);
            }
            handler.postDelayed(this, HEARTBEAT_MS);
        }
    };

    @PluginMethod
    public void start(PluginCall call) {
        wanted = true;
        // Pedido só agora, no primeiro treino: no boot o diálogo não tem contexto e é negado
        // por reflexo — e duas recusas fazem o Android parar de exibi-lo.
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        reallyStart(call);
    }

    /** Negar não impede nada: o serviço roda, só a notificação fica invisível. */
    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        if (!wanted) {
            call.resolve(new JSObject().put("started", false).put("reason", "stopped"));
            return;
        }
        reallyStart(call);
    }

    private void reallyStart(PluginCall call) {
        WorkoutForegroundService.WorkoutNotification.set(call.getString("title", "Treino"), null);

        Context app = getContext().getApplicationContext();
        try {
            ContextCompat.startForegroundService(app, new Intent(app, WorkoutForegroundService.class));
        } catch (Exception e) {
            // ForegroundServiceStartNotAllowedException (Android 12+) quando o start parte do
            // background. Não é fatal: o treino continua enquanto o processo viver.
            Log.e(TAG, "não foi possível iniciar o foreground service", e);
            call.resolve(new JSObject().put("started", false).put("reason", e.getClass().getSimpleName()));
            return;
        }

        running = true;
        ticks = 0;
        handler.removeCallbacks(heartbeat);
        handler.postDelayed(heartbeat, HEARTBEAT_MS);
        call.resolve(new JSObject().put("started", true));
    }

    @PluginMethod
    public void update(PluginCall call) {
        // Renotifica com o mesmo id/canal: chamar startService a partir do background só
        // para trocar um texto esbarraria nas restrições do Android 12+.
        WorkoutForegroundService.WorkoutNotification.update(
                getContext(), call.getString("title"), call.getString("text"));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopHeartbeat();
        requestServiceStop();
        call.resolve();
    }

    /**
     * A WebView que grava morre com a Activity. Um serviço sobrevivendo a ela seguraria a CPU
     * e uma notificação "gravando" de um treino que ninguém mais está gravando — a sessão
     * volta pelo modal de recuperação, que lê o estado salvo.
     */
    @Override
    protected void handleOnDestroy() {
        stopHeartbeat();
        requestServiceStop();
        super.handleOnDestroy();
    }

    /**
     * A parada vai como intent para o próprio serviço, nunca por stopService(): o serviço a
     * processa em ordem com os starts e usa stopSelf(startId), o que torna seguro um stop
     * que chega com um start ainda em voo (ver WorkoutForegroundService.onStartCommand).
     *
     * Sem serviço vivo e sem start pedido não há o que parar — e mandar o intent assim mesmo
     * criaria o serviço só para ele se desligar.
     */
    private void requestServiceStop() {
        boolean hadStart = wanted;
        wanted = false;
        if (!hadStart && !WorkoutForegroundService.isRunning()) return;

        Context app = getContext().getApplicationContext();
        Intent intent = new Intent(app, WorkoutForegroundService.class);
        intent.setAction(WorkoutForegroundService.ACTION_STOP);
        try {
            app.startService(intent);
        } catch (Exception e) {
            // IllegalStateException em segundo plano sem foreground ativo — ou seja, sem
            // serviço rodando, que é justamente o caso em que não há nada a parar.
            Log.w(TAG, "stop do serviço falhou", e);
        }
    }

    private void stopHeartbeat() {
        running = false;
        handler.removeCallbacks(heartbeat);
    }
}
