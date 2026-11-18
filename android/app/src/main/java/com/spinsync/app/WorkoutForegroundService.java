package com.spinsync.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Mantém o treino gravando com a tela apagada ou o app em segundo plano.
 *
 * Sem isto o app dependia só de navigator.wakeLock, que o WebView libera assim que a tela
 * apaga ou o app perde o foco: numa aula de 45 minutos com o celular no bolso, a gravação
 * simplesmente parava. É o mesmo padrão que já funciona no relógio
 * (android/wear/.../HrBroadcastService.kt).
 *
 * Este serviço NÃO grava nada — quem grava é o JS na WebView. O papel dele é manter o
 * processo fora do cache do Android e a CPU acordada; a resolução do tick vem do heartbeat
 * em WorkoutServicePlugin.
 */
public class WorkoutForegroundService extends Service {

    static final String ACTION_STOP = "com.spinsync.app.WORKOUT_STOP";
    private static final String CHANNEL_ID = "workout";
    static final int NOTIF_ID = 2001;
    private static final String TAG = "SpinSync";

    /** Teto de segurança: uma aula não passa disso, e um lock esquecido não drena a noite. */
    private static final long WAKELOCK_TIMEOUT_MS = 4L * 60 * 60 * 1000;

    private PowerManager.WakeLock wakeLock;

    /** Verdadeiro entre um startForeground bem-sucedido e o onDestroy. Lido pelo plugin. */
    private static volatile boolean running = false;

    static boolean isRunning() {
        return running;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /**
     * Toda parada pedida pelo app usa stopSelf(startId), nunca stopSelf() puro. (As únicas
     * exceções são as que o próprio sistema ordena — ver forceStop.)
     *
     * Era isto que fechava o app ao iniciar um treino. O JS pedia stop e start em
     * sequência; o stop criava o serviço, e o stopSelf() sem id derrubava o serviço com o
     * startForegroundService() do start ainda pendente. O sistema trata isso como promessa
     * de foreground quebrada e mata o processo com ForegroundServiceDidNotStartInTimeException
     * ("Bringing down service while still waiting for start foreground" no logcat).
     *
     * stopSelf(startId) só para quando aquele é o pedido mais recente: com um start na fila,
     * a parada é ignorada e o start seguinte sobe o foreground normalmente.
     */
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            shutdown(startId);
            return START_NOT_STICKY;
        }

        createChannel();
        if (!goForeground(resolveType())) {
            // A recusa vem de dentro do próprio startForeground, que já conta como resposta
            // ao startForegroundService() — parar aqui não derruba o processo. O JS segue
            // gravando enquanto o processo viver, só sem a proteção do foreground.
            shutdown(startId);
            return START_NOT_STICKY;
        }
        running = true;
        acquireWakeLock();

        // START_NOT_STICKY de propósito: se o processo morrer, a WebView que grava morre
        // junto. Ressuscitar só o serviço deixaria uma notificação órfã contando um treino
        // que não existe mais — a recuperação real é o estado salvo + o modal de retomada.
        return START_NOT_STICKY;
    }

    /**
     * connectedDevice é o tipo honesto: o serviço existe para manter vivo o link BLE com a
     * cinta e o sensor de cadência.
     *
     * Não dá para usar `health` como no relógio: aquele tipo exige BODY_SENSORS ou
     * ACTIVITY_RECOGNITION concedida, e no celular o sensor é externo — nenhuma delas se
     * aplica. Quando o treino roda sem sensor nenhum (ou em modo demo), BLUETOOTH_CONNECT
     * pode não estar concedida e connectedDevice lançaria SecurityException, então cai para
     * dataSync.
     */
    private int resolveType() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0;

        boolean bluetooth = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT)
                   == PackageManager.PERMISSION_GRANTED;

        return bluetooth
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
    }

    /**
     * Sobe o foreground, com dataSync de reserva se connectedDevice for recusado (fabricante
     * que exige outro pré-requisito, permissão revogada entre a checagem e a chamada).
     */
    private boolean goForeground(int type) {
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, WorkoutNotification.build(this), type);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "startForeground falhou (tipo " + type + ")", e);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && type != ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) {
            try {
                ServiceCompat.startForeground(this, NOTIF_ID, WorkoutNotification.build(this),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                return true;
            } catch (Exception e) {
                Log.e(TAG, "startForeground falhou também como dataSync", e);
            }
        }
        return false;
    }

    /**
     * Android 15+ chama isto quando o tipo dataSync estoura a cota diária (6 h). O sistema
     * exige a parada em segundos, então aqui ela é incondicional — esperar por um start
     * pendente trocaria um crash por outro.
     */
    @Override
    public void onTimeout(int startId) {
        Log.w(TAG, "foreground service atingiu o limite de tempo");
        forceStop();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        onTimeout(startId);
    }

    /** Deslizar o app para fora dos recentes encerra o treino junto. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // O sistema está encerrando a tarefa: não há start legítimo na fila a preservar.
        forceStop();
        super.onTaskRemoved(rootIntent);
    }

    private void forceStop() {
        running = false;
        releaseWakeLock();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        releaseWakeLock();
        super.onDestroy();
    }

    /** Ver o comentário de onStartCommand: o startId é o que torna a parada segura. */
    private void shutdown(int startId) {
        // A notificação e o lock só saem se a parada valer de fato. Com um start pendente,
        // stopSelf(startId) devolve false e o serviço continua — sem notificação e sem lock
        // ele estaria rodando "invisível" até o próximo onStartCommand.
        if (stopSelfResult(startId)) {
            running = false;
            releaseWakeLock();
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        }
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager pm = getSystemService(PowerManager.class);
        if (pm == null) return;
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "spinsync:workout");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(WAKELOCK_TIMEOUT_MS);
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
            // Liberar um lock já liberado não é motivo para derrubar nada.
        }
        wakeLock = null;
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        // IMPORTANCE_LOW: persistente e silenciosa, não é um alerta.
        manager.createNotificationChannel(new NotificationChannel(
                CHANNEL_ID, getString(R.string.workout_channel_name), NotificationManager.IMPORTANCE_LOW));
    }

    /** Constrói e atualiza a notificação do treino. */
    static class WorkoutNotification {
        private static String title = "Treino";
        private static String text = null;
        private static long lastPostedAt = 0;

        /** Renotificar a cada segundo é desperdício puro — mesma lição do módulo wear. */
        private static final long MIN_INTERVAL_MS = 4000;

        static void set(String newTitle, String newText) {
            if (newTitle != null) title = newTitle;
            text = newText;
        }

        static Notification build(android.content.Context ctx) {
            PendingIntent open = PendingIntent.getActivity(
                    ctx, 0, new Intent(ctx, MainActivity.class),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

            return new NotificationCompat.Builder(ctx, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_menu_compass)
                    .setContentTitle(title)
                    .setContentText(text != null ? text : ctx.getString(R.string.workout_notif_idle))
                    .setContentIntent(open)
                    .setOngoing(true)
                    .setSilent(true)
                    .build();
        }

        static void update(android.content.Context ctx, String newTitle, String newText) {
            set(newTitle, newText);
            long now = System.currentTimeMillis();
            if (now - lastPostedAt < MIN_INTERVAL_MS) return;
            lastPostedAt = now;

            NotificationManager manager = ctx.getSystemService(NotificationManager.class);
            if (manager != null) manager.notify(NOTIF_ID, build(ctx));
        }
    }
}
