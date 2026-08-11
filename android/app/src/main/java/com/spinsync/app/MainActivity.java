package com.spinsync.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // capacitor.plugins.json é gerado pelo `cap sync` e lista APENAS plugins vindos de
        // node_modules — um plugin local não entra ali. Precisa ser registrado à mão, e
        // antes do super, porque é o super que constrói a Bridge.
        registerPlugin(WorkoutServicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
