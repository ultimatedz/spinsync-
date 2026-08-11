package com.spinsync.app;

import android.Manifest;
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
        reallyStart(call);
    }

    private void reallyStart(PluginCall call) {
        WorkoutForegroundService.WorkoutNotification.set(call.getString("title", "Treino"), null);

        try {
            ContextCompat.startForegroundService(getContext(),
                    new Intent(getContext(), WorkoutForegroundService.class));
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
        Intent intent = new Intent(getContext(), WorkoutForegroundService.class);
        intent.setAction(WorkoutForegroundService.ACTION_STOP);
        try {
            getContext().startService(intent);
        } catch (Exception e) {
            Log.w(TAG, "stop do serviço falhou", e);
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopHeartbeat();
        super.handleOnDestroy();
    }

    private void stopHeartbeat() {
        running = false;
        handler.removeCallbacks(heartbeat);
    }
}
