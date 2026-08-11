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

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            shutdown();
            return START_NOT_STICKY;
        }

        createChannel();
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, WorkoutNotification.build(this), resolveType());
        } catch (Exception e) {
            // Tipo de serviço sem o pré-requisito satisfeito, ou start negado pelo sistema.
            // Nunca pode derrubar o treino: o JS segue gravando enquanto o processo viver.
            Log.e(TAG, "startForeground falhou", e);
            stopSelf();
            return START_NOT_STICKY;
        }
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

    /** Android 14+ chama isto quando um serviço de tempo limitado estoura a cota. */
    @Override
    public void onTimeout(int startId) {
        Log.w(TAG, "foreground service atingiu o limite de tempo");
        shutdown();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        onTimeout(startId);
    }

    /** Deslizar o app para fora dos recentes encerra o treino junto. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        shutdown();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    private void shutdown() {
        releaseWakeLock();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
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
