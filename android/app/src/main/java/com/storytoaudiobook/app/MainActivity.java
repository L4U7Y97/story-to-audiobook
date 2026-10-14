package com.storytoaudiobook.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.storytoaudiobook.app.narrator.NarratorPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NarratorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
