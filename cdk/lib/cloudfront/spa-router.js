function handler(event) {
    var request = event.request;
    var uri = request.uri;

    // Remove trailing slash (except root)
    if (uri.length > 1 && uri.endsWith('/')) {
        uri = uri.slice(0, -1);
    }

    // Exact legal route mapping
    var routes = {
        "/privacy": "/privacy.html",
        "/terms": "/terms.html",
        "/data-deletion": "/data-deletion.html"
    };

    if (routes[uri]) {
        request.uri = routes[uri];
        return request;
    }

    request.uri = "/index.html";


    return request;
}
