package com.spinsync.app;

import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "SpinSync";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // capacitor.plugins.json é gerado pelo `cap sync` e lista APENAS plugins vindos de
        // node_modules — um plugin local não entra ali. Precisa ser registrado à mão, e
        // antes do super, porque é o super que constrói a Bridge.
        registerPlugin(WorkoutServicePlugin.class);
        super.onCreate(savedInstanceState);

        if (bridge != null) bridge.addWebViewListener(new RendererGuard());
    }

    /**
     * Sobrevive à morte do processo de renderização da WebView.
     *
     * O renderer do Chromium é um processo à parte. Com a tela apagada ele perde a
     * prioridade da Activity e é o primeiro a ser morto quando falta memória — e pode
     * travar por conta própria. Sem um listener que responda true, a WebView derruba o app
     * inteiro junto ("Render process's crash wasn't handled"), e era isso que o Capacitor
     * fazia por padrão: o treino fechava no meio, mesmo com o foreground service ativo.
     *
     * Recriar a Activity reconstrói a Bridge com uma WebView nova; o JS sobe, encontra o
     * estado salvo a cada 5 s e oferece a retomada pelo modal de recuperação.
     */
    private final class RendererGuard extends WebViewListener {
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.e(TAG, "renderer da WebView morreu: crash=" + detail.didCrash()
                    + " prioridade=" + detail.rendererPriorityAtExit());
            if (isFinishing() || isDestroyed()) return true;

            // Uma página que derruba o renderer ao carregar entraria em laço de recriação.
            long now = SystemClock.elapsedRealtime();
            if (now - lastRendererRecreateAt < RENDERER_LOOP_WINDOW_MS) {
                Log.e(TAG, "renderer morreu de novo logo após recriar — encerrando");
                finish();
                return true;
            }
            lastRendererRecreateAt = now;
            recreate();
            return true;
        }
    }

    /** Estático porque a Activity é recriada: o campo de instância nasceria zerado. */
    private static long lastRendererRecreateAt = 0;
    private static final long RENDERER_LOOP_WINDOW_MS = 15_000;
}
