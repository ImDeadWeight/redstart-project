package com.redstart.app;

import android.content.Context;
import android.net.DhcpInfo;
import android.net.wifi.WifiManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "NetworkDiscovery")
public class NetworkDiscoveryPlugin extends Plugin {

    private static final int BEACON_PORT = 8765;
    private static final int CONNECT_TIMEOUT_MS = 400;
    private static final int HTTP_TIMEOUT_MS = 2000;
    private static final int MAX_THREADS = 64;
    private static final int SCAN_DEADLINE_SECONDS = 45;

    @PluginMethod
    public void getLocalNetworkInfo(final PluginCall call) {
        try {
            WifiManager wifi = (WifiManager) getContext()
                    .getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);

            if (wifi == null) {
                call.reject("WifiManager not available");
                return;
            }

            DhcpInfo dhcp = wifi.getDhcpInfo();
            String ip = intToIp(dhcp.ipAddress);
            String gateway = intToIp(dhcp.gateway);
            String subnet = ip.substring(0, ip.lastIndexOf('.'));

            JSObject result = new JSObject();
            result.put("ip", ip);
            result.put("subnet", subnet);
            result.put("gateway", gateway);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to get network info: " + e.getMessage());
        }
    }

    @PluginMethod
    public void scanForServers(final PluginCall call) {
        call.setKeepAlive(true);

        final String subnet = call.getString("subnet");
        if (subnet == null || subnet.isEmpty()) {
            call.reject("subnet is required");
            return;
        }

        final int connectTimeout = call.getInt("timeout", CONNECT_TIMEOUT_MS);

        new Thread(() -> {
            ExecutorService executor = Executors.newFixedThreadPool(MAX_THREADS);
            List<Callable<JSObject>> tasks = new ArrayList<>();

            for (int host = 1; host <= 254; host++) {
                final String ip = subnet + "." + host;
                tasks.add(() -> {
                    if (isPortOpen(ip, BEACON_PORT, connectTimeout)) {
                        return probeRedstartNestBeacon(ip);
                    }
                    return null;
                });
            }

            try {
                List<Future<JSObject>> futures = executor.invokeAll(
                        tasks, SCAN_DEADLINE_SECONDS, TimeUnit.SECONDS);
                executor.shutdown();

                JSArray servers = new JSArray();
                for (Future<JSObject> f : futures) {
                    try {
                        JSObject server = f.get();
                        if (server != null) {
                            servers.put(server);
                        }
                    } catch (Exception ignored) {
                        // task threw or was cancelled — skip
                    }
                }

                JSObject result = new JSObject();
                result.put("servers", servers);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Scan failed: " + e.getMessage());
            }
        }).start();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private boolean isPortOpen(String ip, int port, int timeoutMs) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(ip, port), timeoutMs);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * Probes the Redstart Nest identity beacon at http://ip:8765.
     * Returns a server JSObject with url/ip/port if the host is a running Redstart Nest
     * instance, or null if it is not or the beacon response is invalid.
     */
    private JSObject probeRedstartNestBeacon(String ip) {
        try {
            URL url = new URL("http://" + ip + ":" + BEACON_PORT);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(HTTP_TIMEOUT_MS);
            conn.setReadTimeout(HTTP_TIMEOUT_MS);
            conn.setRequestMethod("GET");

            int code = conn.getResponseCode();
            if (code != 200) {
                conn.disconnect();
                return null;
            }

            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
            reader.close();
            conn.disconnect();

            JSONObject json = new JSONObject(sb.toString());
            if (!"redstart-nest".equals(json.optString("app"))) return null;

            JSONObject serverInfo = json.optJSONObject("server");
            if (serverInfo == null) return null;
            if (!serverInfo.optBoolean("running", false)) return null;

            // networkUrl is the reachable address from Android (remote device)
            String networkUrl = serverInfo.optString("networkUrl", null);
            if (networkUrl == null || networkUrl.isEmpty() || "null".equals(networkUrl)) return null;

            JSObject result = new JSObject();
            result.put("url", networkUrl);
            result.put("ip", ip);
            result.put("port", serverInfo.optInt("port", 8080));
            return result;
        } catch (Exception e) {
            return null;
        }
    }

    /** Convert a little-endian int (from WifiManager) to a dotted-decimal string. */
    private static String intToIp(int ip) {
        return (ip & 0xFF) + "." +
               ((ip >> 8) & 0xFF) + "." +
               ((ip >> 16) & 0xFF) + "." +
               ((ip >> 24) & 0xFF);
    }
}
