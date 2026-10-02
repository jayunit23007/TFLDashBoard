const ALLOWED_ORIGINS = new Set([
    "https://jayunit23007.github.io",
    "http://localhost:8765",
    "http://127.0.0.1:8765"
]);

const C2C_AJAX_URL = "https://www.c2c-online.co.uk/wp/wp-admin/admin-ajax.php";
const STATION_PAIRS = new Set(["UPM:FST", "FST:UPM"]);

function jsonResponse(data, status, origin) {
    const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Vary", "Origin");
    }
    return new Response(JSON.stringify(data), { status, headers });
}

function cleanCell(value) {
    return value
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;|&#160;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&#x27;/gi, "'")
        .replace(/\s+/g, " ")
        .trim();
}

function parseDepartures(markup) {
    const departures = [];
    for (const row of markup.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
            .map(cell => cleanCell(cell[1]));
        if (cells.length < 4 || !/^\d{1,2}:\d{2}$/.test(cells[0])) continue;
        departures.push({
            time: cells[0],
            service: cells[1],
            platform: cells[2],
            status: cells[3]
        });
    }
    return departures;
}

export default {
    async fetch(request) {
        const origin = request.headers.get("Origin") || "";
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            if (!ALLOWED_ORIGINS.has(origin)) {
                return new Response(null, { status: 403 });
            }
            return new Response(null, {
                status: 204,
                headers: {
                    "Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Max-Age": "86400",
                    "Vary": "Origin"
                }
            });
        }

        if (origin && !ALLOWED_ORIGINS.has(origin)) {
            return jsonResponse({ error: "Origin is not allowed." }, 403, "");
        }
        if (request.method !== "GET") {
            return jsonResponse({ error: "Use GET to request departures." }, 405, origin);
        }
        if (url.pathname !== "/departures") {
            return jsonResponse({ error: "Use /departures?from=UPM&to=FST." }, 404, origin);
        }

        const from = (url.searchParams.get("from") || "").toUpperCase();
        const to = (url.searchParams.get("to") || "").toUpperCase();
        if (!STATION_PAIRS.has(`${from}:${to}`)) {
            return jsonResponse({ error: "Only the UPM and FST c2c routes are supported." }, 400, origin);
        }

        try {
            const upstream = await fetch(C2C_AJAX_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Origin": "https://www.c2c-online.co.uk",
                    "Referer": "https://www.c2c-online.co.uk/"
                },
                body: new URLSearchParams({ action: "jcDepartures", origin: from, destination: to }),
                signal: AbortSignal.timeout(12000)
            });
            if (!upstream.ok) {
                return jsonResponse({ error: "c2c could not return live departures." }, 502, origin);
            }

            const departures = parseDepartures(await upstream.text());
            return jsonResponse({ from, to, departures, updatedAt: new Date().toISOString() }, 200, origin);
        } catch (error) {
            console.error("c2c departures request failed", error);
            return jsonResponse({ error: "c2c live departures are temporarily unavailable." }, 502, origin);
        }
    }
};