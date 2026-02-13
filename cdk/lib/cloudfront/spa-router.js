function handler(event) {
    var request = event.request;
    var uri = request.uri;

    // 1) Normalize: remove trailing slash (except root)
    if (uri.length > 1 && uri.endsWith("/")) {
        uri = uri.slice(0, -1);
    }

    // 2) Exact legal route mapping (your requirement)
    var routes = {
        "/privacy": "/privacy.html",
        "/terms": "/terms.html",
        "/data-deletion": "/data-deletion.html",
    };

    if (routes[uri]) {
        request.uri = routes[uri];
        return request;
    }

    // 3) Allow-list exact PWA/control files served from root
    // (These must NOT be rewritten to index.html)
    if (
        uri === "/manifest.webmanifest" ||
        uri === "/sw.js" ||
        uri === "/registerSW.js" ||
        uri === "/robots.txt" ||
        uri === "/favicon.ico" ||
        uri === "/favicon.svg"
    ) {
        request.uri = uri;
        return request;
    }

    // 4) Allow Vite build assets and app icons as-is
    // Vite outputs /assets/* for hashed JS/CSS by default.
    if (uri.startsWith("/assets/") || uri.startsWith("/icons/")) {
        request.uri = uri;
        return request;
    }

    // 5) Allow common static file extensions as-is (tight whitelist)
    // This covers things like images, fonts, css/js (if ever outside /assets), sourcemaps, json, webmanifest, etc.
    // If it looks like a file, we let it pass through.
    var hasStaticExt = /\/[^\/]+\.(?:css|js|mjs|map|json|txt|xml|webmanifest|ico|png|jpg|jpeg|webp|svg|gif|avif|woff2?|ttf|otf|eot)$/i.test(uri);
    if (hasStaticExt) {
        request.uri = uri;
        return request;
    }

    // 6) Everything else is a SPA route -> index.html
    request.uri = "/index.html";
    return request;
}
