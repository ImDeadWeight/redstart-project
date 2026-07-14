package com.beaver.app;

import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NetworkDiscoveryPlugin.class);
        super.onCreate(savedInstanceState);
        // The app connects to a local HTTP server over LAN. Allow http:// fetches
        // from the https://localhost WebView origin (mixed content).
        getBridge().getWebView().getSettings()
                .setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    }
}
