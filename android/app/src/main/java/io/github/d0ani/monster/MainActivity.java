package io.github.d0ani.monster;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

/**
 * Schlanke App-Hülle um https://d0ani.github.io/monster/ – Angebote kommen immer live von der Website,
 * die App muss für neue Daten also nie aktualisiert werden.
 */
public class MainActivity extends Activity {
    private static final String START_URL = "https://d0ani.github.io/monster/";
    private static final String SITE_HOST = "d0ani.github.io";
    private static final String SITE_PATH = "/monster";
    private static final int REQUEST_LOCATION = 42;

    private static final String OFFLINE_HTML = "<!doctype html><html lang='de'><head>"
            + "<meta name='viewport' content='width=device-width,initial-scale=1'><style>"
            + "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0b0d;color:#f3f5f8;"
            + "font:16px system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}"
            + "p{color:#9ba2ad}button{margin-top:16px;padding:12px 22px;border:0;border-radius:12px;"
            + "background:#f4f6f8;color:#0a0b0d;font-weight:700;font-size:16px}</style></head><body><div>"
            + "<h2>Keine Verbindung</h2><p>Die Angebote werden live geladen – bitte Internet prüfen.</p>"
            + "<button onclick=\"location.href='" + START_URL + "'\">Erneut versuchen</button></div></body></html>";

    private WebView web;
    private SwipeRefreshLayout swipe;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0A0B0D);
        swipe = new SwipeRefreshLayout(this);
        swipe.addView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        swipe.setColorSchemeColors(0xFF7CC9E8);
        swipe.setProgressBackgroundColorSchemeColor(0xFF1A1C20);
        // Nach unten ziehen lädt nur neu, wenn die Seite ganz oben ist
        swipe.setOnChildScrollUpCallback((parent, child) -> web.getScrollY() > 0);
        swipe.setOnRefreshListener(() -> {
            String current = web.getUrl();
            if (current == null || !current.startsWith("https://")) {
                web.loadUrl(START_URL);
            } else {
                web.reload();
            }
        });
        setContentView(swipe);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        // Kennung, damit die Website z. B. den "App herunterladen"-Link in der App ausblendet
        settings.setUserAgentString(settings.getUserAgentString() + " MonsterAngeboteApp/" + BuildConfig.VERSION_NAME);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isOwnSite(uri)) {
                    return false;
                }
                openExternal(uri); // Quellen, OpenStreetMap, GitHub … im Browser öffnen
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                swipe.setRefreshing(false);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    view.loadDataWithBaseURL(null, OFFLINE_HTML, "text/html", "utf-8", null);
                    swipe.setRefreshing(false);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                    return;
                }
                pendingGeoOrigin = origin;
                pendingGeoCallback = callback;
                requestPermissions(new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION
                }, REQUEST_LOCATION);
            }
        });

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(startUrlFrom(getIntent()));
        }
    }

    private String startUrlFrom(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        return data != null && isOwnSite(data) ? data.toString() : START_URL;
    }

    private static boolean isOwnSite(Uri uri) {
        String path = uri.getPath();
        return "https".equals(uri.getScheme()) && SITE_HOST.equals(uri.getHost())
                && path != null && path.startsWith(SITE_PATH);
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // kein Browser installiert – Link einfach ignorieren
        }
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_LOCATION && pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, hasLocationPermission(), false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) {
            web.loadUrl(startUrlFrom(intent));
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
