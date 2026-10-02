"use strict";

const STORAGE_KEY = "tfl-commute-dashboard-v2";
const BACKUP_FORMAT = "tfl-commute-dashboard";
const BACKUP_VERSION = 1;
const REFRESH_INTERVAL_MS = 30000;
const TFL_API_BASE = "https://api.tfl.gov.uk";
const C2C_PROXY_BASE = "https://tfl-c2c-proxy.jaylooinfo.workers.dev";

// Optional: add your TfL API key here for sustained use.
const TFL_APP_KEY = "";

let config = {
    home: { busStops: [], stations: [] },
    work: { busStops: [], stations: [] }
};
let overgroundLinesPromise;
let collapseSectionSequence = 0;
const collapsedSectionKeys = new Set();
const overgroundRouteCache = new Map();

function withApiKey(url) {
    if (!TFL_APP_KEY) return url;
    return `${url}${url.includes("?") ? "&" : "?"}app_key=${encodeURIComponent(TFL_APP_KEY)}`;
}

async function fetchJson(url) {
    const response = await fetch(withApiKey(url), {
        headers: { Accept: "application/json" }
    });
    if (!response.ok) {
        let detail = "";
        try {
            const body = await response.json();
            detail = body.message ? `: ${body.message}` : "";
        } catch (_) {}
        throw new Error(`TfL request failed (${response.status})${detail}`);
    }
    return response.json();
}

function loadConfig() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (!saved) return;
        for (const location of ["home", "work"]) {
            config[location].busStops = Array.isArray(saved[location]?.busStops) ? saved[location].busStops : [];
            config[location].stations = Array.isArray(saved[location]?.stations) ? saved[location].stations : [];
        }
    } catch (error) {
        console.warn("Saved dashboard settings could not be read.", error);
    }
}

function saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function setSetupMessage(text, state = "") {
    const message = document.getElementById("setup-message");
    if (!message) return;
    message.textContent = text;
    message.className = `setup-message ${state}`.trim();
}

function exportSetup() {
    const backup = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        config
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tfl-commute-setup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSetupMessage("Setup saved as a JSON file.", "success");
}

function validateSetupBackup(backup) {
    if (!backup || backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) {
        throw new Error("This file is not a supported commute setup backup.");
    }

    const imported = {};
    for (const location of ["home", "work"]) {
        const savedLocation = backup.config?.[location];
        if (!savedLocation || !Array.isArray(savedLocation.busStops) || !Array.isArray(savedLocation.stations)) {
            throw new Error("The setup file is missing valid Home or Work selections.");
        }
        const hasFields = (item, fields) => item && fields.every(field =>
            typeof item[field] === "string" && item[field].trim()
        );
        if (!savedLocation.busStops.every(item => hasFields(item, ["id", "stopCode", "stopId", "name"]))) {
            throw new Error(`The ${location} bus-stop data is invalid.`);
        }
        if (!savedLocation.stations.every(item => hasFields(item, ["id", "stopId", "stationName", "line", "direction"]))) {
            throw new Error(`The ${location} station data is invalid.`);
        }
        imported[location] = {
            busStops: savedLocation.busStops.map(({ id, stopCode, stopId, name }) => ({ id, stopCode, stopId, name })),
            stations: savedLocation.stations.map(({ id, stopId, stationName, line, direction }) => ({ id, stopId, stationName, line, direction }))
        };
    }
    return imported;
}

async function applySetupBackup(backup) {
    const imported = validateSetupBackup(backup);
    const hasCurrentSelections = ["home", "work"].some(location =>
        config[location].busStops.length || config[location].stations.length
    );
    if (hasCurrentSelections && !window.confirm("Loading this setup will replace the bus stops and stations currently saved on this device. Continue?")) {
        return false;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(imported));
    config = imported;
    await refreshAll();
    return true;
}

async function importSetup(file) {
    try {
        const backup = JSON.parse(await file.text());
        if (await applySetupBackup(backup)) setSetupMessage("Setup loaded. Home and Work selections are ready.", "success");
    } catch (error) {
        console.error("The commute setup could not be loaded.", error);
        setSetupMessage(error.message || "The setup file could not be loaded.", "error");
    }
}

async function loadSuppliedSetup() {
    try {
        const response = await fetch("./tfl-commute-setup-2026-10-02.json");
        if (!response.ok) throw new Error("The supplied commute setup file could not be loaded.");
        if (await applySetupBackup(await response.json())) {
            setSetupMessage("Supplied Home and Work setup loaded.", "success");
        }
    } catch (error) {
        console.error("The supplied commute setup could not be loaded.", error);
        setSetupMessage(error.message || "The supplied setup could not be loaded.", "error");
    }
}

function uid() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, character => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[character]);
}

function titleCase(value = "") {
    return String(value).split("-").map(word => word ? word[0].toUpperCase() + word.slice(1) : "").join(" ");
}

function formatMinutes(seconds) {
    const minutes = Math.max(0, Math.ceil(Number(seconds) / 60));
    return minutes <= 1 ? "Due" : `${minutes} min`;
}

function setMessage(location, type, text, state = "") {
    const element = document.getElementById(`${location}-${type}-message`);
    if (!element) return;
    element.textContent = text;
    element.className = `form-message ${state}`.trim();
}

function setupCollapsibleSection(section) {
    const heading = section.querySelector(":scope > .card-heading, :scope > .board-header");
    if (!heading || heading.querySelector("[data-collapse-toggle]")) return;

    let body = section.querySelector(":scope > .collapsible-content");
    if (!body) {
        body = document.createElement("div");
        body.className = "collapsible-content";
        body.id = `collapsible-content-${++collapseSectionSequence}`;
        for (const child of Array.from(section.children)) {
            if (child !== heading) body.append(child);
        }
        section.append(body);
    }

    if (!section.dataset.collapseKey) {
        section.dataset.collapseKey = section.dataset.busId
            ? `bus-${section.dataset.busId}`
            : section.dataset.stationId
                ? `station-${section.dataset.stationId}`
                : `section-${collapseSectionSequence}`;
    }
    const key = section.dataset.collapseKey;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button collapse-toggle";
    button.dataset.collapseToggle = "";
    button.setAttribute("aria-controls", body.id);
    button.setAttribute("aria-expanded", String(!collapsedSectionKeys.has(key)));
    button.setAttribute("aria-label", collapsedSectionKeys.has(key) ? "Expand section" : "Collapse section");
    button.title = button.getAttribute("aria-label");
    button.textContent = collapsedSectionKeys.has(key) ? "+" : "−";
    body.hidden = collapsedSectionKeys.has(key);
    button.addEventListener("click", () => {
        const isExpanded = button.getAttribute("aria-expanded") === "true";
        body.hidden = isExpanded;
        button.setAttribute("aria-expanded", String(!isExpanded));
        button.setAttribute("aria-label", isExpanded ? "Expand section" : "Collapse section");
        button.title = button.getAttribute("aria-label");
        button.textContent = isExpanded ? "+" : "−";
        if (isExpanded) collapsedSectionKeys.add(key);
        else collapsedSectionKeys.delete(key);
    });

    const actions = heading.querySelector(":scope > .board-actions");
    (actions || heading).append(button);
}

function setupCollapsibleSections(root = document) {
    root.querySelectorAll(".transport-card, .stop-board, .station-board").forEach(setupCollapsibleSection);
}

/* A five-digit SMS stop code is not the same as a NaPTAN StopPoint ID.
   Search is used to resolve the code, then the StopPoint ID is stored. */
async function findBusStop(stopCode) {
    const searchUrls = [
        `${TFL_API_BASE}/StopPoint/Search/${encodeURIComponent(stopCode)}?modes=bus`,
        `${TFL_API_BASE}/StopPoint/Search?query=${encodeURIComponent(stopCode)}&modes=bus`
    ];
    let matches = [];
    for (const url of searchUrls) {
        try {
            const data = await fetchJson(url);
            matches = data.matches || [];
            if (matches.length) break;
        } catch (_) {}
    }
    if (!matches.length) {
        throw new Error(`Stop code ${stopCode} was not found. Check the five-digit code shown on the stop.`);
    }
    const exact = matches.find(match =>
        String(match.id || "").includes(stopCode) ||
        String(match.name || "").includes(stopCode)
    );
    return exact || matches[0];
}

async function addBusStop(location) {
    const input = document.getElementById(`${location}-stop-code`);
    const stopCode = input.value.trim();
    if (!/^\d{5}$/.test(stopCode)) {
        setMessage(location, "bus", "Enter a valid five-digit stop code.", "error");
        return;
    }
    if (config[location].busStops.some(stop => stop.stopCode === stopCode)) {
        setMessage(location, "bus", "That stop is already being monitored.", "error");
        return;
    }
    setMessage(location, "bus", "Finding bus stop...");
    try {
        const match = await findBusStop(stopCode);
        config[location].busStops.push({
            id: uid(), stopCode, stopId: match.id, name: match.name || `Stop ${stopCode}`
        });
        saveConfig();
        input.value = "";
        setMessage(location, "bus", `${match.name || `Stop ${stopCode}`} was added.`, "success");
        await loadBusBoards(location);
    } catch (error) {
        console.error(error);
        setMessage(location, "bus", error.message, "error");
    }
}

async function getBusArrivals(stop) {
    const arrivals = await fetchJson(`${TFL_API_BASE}/StopPoint/${encodeURIComponent(stop.stopId)}/Arrivals`);
    return arrivals
        .filter(item => item.modeName === "bus" || item.lineId || item.lineName)
        .filter(item => Number.isFinite(item.timeToStation))
        .sort((a, b) => a.timeToStation - b.timeToStation)
        .slice(0, 6);
}

function busBoardHeader(stop, location) {
    return `<div class="board-header">
        <div><h4>${escapeHtml(stop.name)}</h4><p class="board-subtitle">Stop code ${escapeHtml(stop.stopCode)}</p></div>
        <div class="board-actions"><button class="secondary-button" type="button" data-refresh-bus="${escapeHtml(stop.id)}" data-location="${location}">Refresh</button><button class="remove-button" type="button" data-remove-bus="${escapeHtml(stop.id)}" data-location="${location}">Remove</button></div>
    </div>`;
}

async function createBusBoard(stop, location) {
    const board = document.createElement("article");
    board.className = "stop-board";
    board.dataset.busId = stop.id;
    board.innerHTML = `${busBoardHeader(stop, location)}<p class="loading-message">Loading live arrivals...</p>`;
    try {
        const arrivals = await getBusArrivals(stop);
        board.innerHTML = busBoardHeader(stop, location) + (arrivals.length ? arrivals.map(bus => `
            <div class="departure-row">
                <div class="route-badge">${escapeHtml(bus.lineName || bus.lineId || "Bus")}</div>
                <div class="departure-destination"><strong>${escapeHtml(bus.destinationName || bus.towards || "Destination unavailable")}</strong><span>${escapeHtml(bus.currentLocation || "Live prediction")}</span></div>
                <div class="departure-platform">${escapeHtml(bus.platformName || "")}</div>
                <div class="departure-time">${formatMinutes(bus.timeToStation)}</div>
            </div>`).join("") : `<p class="empty-message">No live bus arrivals are currently reported.</p>`);
    } catch (error) {
        console.error(error);
        board.innerHTML = `${busBoardHeader(stop, location)}<p class="error-message">Live arrivals could not be loaded.</p>`;
    }
    setupCollapsibleSection(board);
    return board;
}

async function loadBusBoards(location) {
    const container = document.getElementById(`${location}-buses`);
    const stops = config[location].busStops;
    if (!stops.length) {
        container.innerHTML = `<p class="empty-message">No ${titleCase(location)} bus stops have been added.</p>`;
        return;
    }
    container.innerHTML = `<p class="loading-message">Updating live bus arrivals...</p>`;
    container.replaceChildren(...await Promise.all(stops.map(stop => createBusBoard(stop, location))));
}

async function findStation(stationName, line) {
    const modes = "tube,dlr,overground,elizabeth-line,tram";
    const data = await fetchJson(`${TFL_API_BASE}/StopPoint/Search/${encodeURIComponent(stationName)}?modes=${modes}`);
    const matches = data.matches || [];
    if (!matches.length) throw new Error(`No TfL station was found for “${stationName}”.`);
    const target = normalizeStationName(stationName);
    const exactName = match => normalizeStationName(match.name || match.commonName) === target;
    const servesLine = match => (match.modes || []).some(mode => String(mode).toLowerCase().includes(line.toLowerCase()));
    const match = matches.find(item => exactName(item) && servesLine(item))
        || matches.find(exactName)
        || matches.find(servesLine)
        || matches[0];
    return resolveLineStopPoint(match, line, stationName);
}

function normalizeStationName(name = "") {
    return String(name).toLowerCase().replace(/(?:\s+(?:station|underground|rail))+$/g, "").trim();
}

async function resolveLineStopPoint(stopPoint, line, stationName = "") {
    try {
        const lineStops = await fetchJson(`${TFL_API_BASE}/Line/${encodeURIComponent(line)}/StopPoints`);
        const target = normalizeStationName(stationName || stopPoint.name || stopPoint.commonName);
        const lineStop = lineStops.find(item => normalizeStationName(item.commonName || item.name) === target);
        if (lineStop) return lineStop;
    } catch (_) {}

    try {
        const details = await fetchJson(`${TFL_API_BASE}/StopPoint/${encodeURIComponent(stopPoint.id)}`);
        const child = (details.children || []).find(item =>
            (item.modes || []).some(mode => String(mode).toLowerCase().includes(line.toLowerCase()))
        );
        return child || stopPoint;
    } catch (_) {
        return stopPoint;
    }
}

async function addStation(location) {
    const nameInput = document.getElementById(`${location}-station-name`);
    const lineInput = document.getElementById(`${location}-line`);
    const directionInput = document.getElementById(`${location}-direction`);
    const stationName = nameInput.value.trim();
    const line = lineInput.value;
    const direction = directionInput.value;
    if (!stationName || !line || !direction) {
        setMessage(location, "station", "Enter a station and select a line and direction.", "error");
        return;
    }
    setMessage(location, "station", "Finding station...");
    try {
        const match = await findStation(stationName, line);
        if (config[location].stations.some(item => item.stopId === match.id && item.line === line && item.direction === direction)) {
            setMessage(location, "station", "That station, line and direction are already monitored.", "error");
            return;
        }
        config[location].stations.push({
            id: uid(), stopId: match.id, stationName: match.name || stationName, line, direction
        });
        saveConfig();
        nameInput.value = ""; lineInput.value = ""; directionInput.value = "";
        setMessage(location, "station", `${match.name || stationName} was added.`, "success");
        await loadStationBoards(location);
    } catch (error) {
        console.error(error);
        setMessage(location, "station", error.message, "error");
    }
}

function directionMatches(arrival, selectedDirection) {
    const selected = selectedDirection.toLowerCase().replace("anti-clockwise", "anticlockwise");
    const description = [arrival.direction, arrival.platformName, arrival.towards, arrival.destinationName]
        .filter(Boolean).join(" ").toLowerCase().replace("anti-clockwise", "anticlockwise");
    return description.includes(selected);
}

function stationArrivalsUrl(station) {
    return `${TFL_API_BASE}/StopPoint/${encodeURIComponent(station.stopId)}/Arrivals`;
}

async function getOvergroundRouteInfo(station) {
    if (overgroundRouteCache.has(station.stopId)) return overgroundRouteCache.get(station.stopId);
    if (!overgroundLinesPromise) overgroundLinesPromise = fetchJson(`${TFL_API_BASE}/Line/Mode/overground`);

    const [details, lines] = await Promise.all([
        fetchJson(`${TFL_API_BASE}/StopPoint/${encodeURIComponent(station.stopId)}`),
        overgroundLinesPromise
    ]);
    const lineIds = new Set(lines.map(line => line.id));
    const line = (details.lines || []).find(candidate => lineIds.has(candidate.id));
    if (!line) return null;

    const route = await fetchJson(`${TFL_API_BASE}/Line/${encodeURIComponent(line.id)}/Route/Sequence/all`);
    const info = {
        lineId: line.id,
        stations: route.stations || [],
        sequences: route.stopPointSequences || []
    };
    overgroundRouteCache.set(station.stopId, info);
    return info;
}

function inferOvergroundDirection(station, arrival, routeInfo) {
    const destination = normalizeStationName(arrival.destinationName || arrival.towards || "");
    if (!destination) return "";

    for (const sequence of routeInfo.sequences) {
        const points = sequence.stopPoint || [];
        const terminal = points[points.length - 1];
        if (!terminal || normalizeStationName(terminal.name || "") !== destination) continue;

        const stationIndex = points.findIndex(point =>
            point.id === station.stopId || normalizeStationName(point.name || "") === normalizeStationName(station.stationName)
        );
        if (stationIndex < 0) continue;
        const fromPoint = stationIndex < points.length - 1 ? points[stationIndex] : points[stationIndex - 1];
        const toPoint = stationIndex < points.length - 1 ? points[stationIndex + 1] : points[stationIndex];
        const coordinatesFor = point => routeInfo.stations.find(candidate =>
            candidate.id === point.id || normalizeStationName(candidate.name || "") === normalizeStationName(point.name || "")
        );
        const from = coordinatesFor(fromPoint);
        const to = coordinatesFor(toPoint);
        if (!from || !to || !Number.isFinite(from.lat) || !Number.isFinite(to.lat)) continue;

        const latitudeChange = to.lat - from.lat;
        const longitudeChange = to.lon - from.lon;
        if (Math.abs(longitudeChange) >= Math.abs(latitudeChange)) {
            return longitudeChange >= 0 ? "eastbound" : "westbound";
        }
        return latitudeChange >= 0 ? "northbound" : "southbound";
    }
    return "";
}

async function getTrainArrivals(station) {
    const arrivals = await fetchJson(stationArrivalsUrl(station));
    const isOverground = station.line.toLowerCase() === "london-overground";
    const routeInfo = isOverground ? await getOvergroundRouteInfo(station) : null;
    const lineMatches = arrivals.filter(item => {
        if (isOverground) {
            return routeInfo
                ? item.lineId === routeInfo.lineId
                : String(item.modeName || "").toLowerCase() === "overground";
        }
        const value = String(item.lineId || item.lineName || "").toLowerCase();
        return value === station.line.toLowerCase() || value.includes(station.line.toLowerCase());
    });
    const directionMatchesOnly = lineMatches.filter(item => directionMatches(item, station.direction));
    const selectedDirection = station.direction.toLowerCase();
    const selectedDirections = selectedDirection === "east-west"
        ? ["eastbound", "westbound"]
        : [selectedDirection];
    if (isOverground && routeInfo && (selectedDirection === "east-west"
        || ["eastbound", "westbound", "northbound", "southbound"].includes(selectedDirection))) {
        const inferred = lineMatches.map(item => ({
            item,
            direction: inferOvergroundDirection(station, item, routeInfo)
        }));
        if (selectedDirection === "east-west") {
            return selectedDirections.flatMap(direction => inferred
                .filter(result => directionMatches(result.item, direction) || result.direction === direction)
                .slice(0, 6)
                .map(result => result.item))
                .filter(item => Number.isFinite(item.timeToStation))
                .sort((a, b) => a.timeToStation - b.timeToStation);
        }
        if (inferred.some(result => result.direction)) {
            return inferred
                .filter(result => directionMatches(result.item, station.direction) || result.direction === station.direction.toLowerCase())
                .map(result => result.item)
                .filter(item => Number.isFinite(item.timeToStation))
                .sort((a, b) => a.timeToStation - b.timeToStation)
                .slice(0, 6);
        }
    }
    const isElizabethLine = station.line === "elizabeth";
    const hasExplicitElizabethDirection = isElizabethLine
        && ["inbound", "outbound"].includes(String(station.direction || "").toLowerCase());
    // TfL does not always expose a compass direction. Prefer exact direction matches;
    // otherwise show line-matched services and expose platform/destination to the user.
    const selectedArrivals = isElizabethLine
        ? hasExplicitElizabethDirection ? directionMatchesOnly : []
        : directionMatchesOnly.length ? directionMatchesOnly : lineMatches;
    return selectedArrivals
        .filter(item => Number.isFinite(item.timeToStation))
        .sort((a, b) => a.timeToStation - b.timeToStation)
        .slice(0, 6);
}

async function getTrainLineStatus(station) {
    const statusUrl = station.line === "london-overground"
        ? `${TFL_API_BASE}/Line/Mode/overground/Status`
        : `${TFL_API_BASE}/Line/${encodeURIComponent(station.line)}/Status`;
    const lines = await fetchJson(statusUrl);
    const statuses = lines.flatMap(line => (line.lineStatuses || []).map(status => ({
        ...status,
        serviceLine: line.name
    })))
        .filter(status => status.statusSeverity != null && Number.isFinite(Number(status.statusSeverity)))
        .sort((left, right) => Number(left.statusSeverity) - Number(right.statusSeverity));
    const status = statuses[0];
    if (!status) return null;

    const severity = Number(status.statusSeverity);
    return {
        description: `${severity < 10 && station.line === "london-overground" ? `${status.serviceLine}: ` : ""}${status.statusSeverityDescription || "Service status unavailable"}`,
        reason: status.reason || "",
        tone: severity >= 10 ? "status-good" : severity >= 8 ? "status-warning" : "status-disrupted"
    };
}

function updateTrainLineStatus(board, station) {
    getTrainLineStatus(station).then(status => {
        const element = board.querySelector("[data-line-service-status]");
        if (!element) return;
        element.textContent = status?.description || "Service status unavailable";
        element.className = `line-service-status ${status?.tone || "status-unavailable"}`;
        if (status?.reason) element.title = status.reason;
    }).catch(error => {
        console.warn("Train line service status could not be loaded.", error);
        const element = board.querySelector("[data-line-service-status]");
        if (!element) return;
        element.textContent = "Service status unavailable";
        element.className = "line-service-status status-unavailable";
    });
}

function stationBoardHeader(station, location) {
    const arrivalsUrl = stationArrivalsUrl(station);
    const directionLabel = station.direction === "east-west"
        ? "Eastbound and Westbound"
        : titleCase(station.direction);
    return `<div class="board-header">
        <div><h4>${escapeHtml(station.stationName)}</h4><p class="board-subtitle">${escapeHtml(titleCase(station.line))} · ${escapeHtml(directionLabel)}</p><p class="line-service-status status-loading" data-line-service-status role="status">Checking service status...</p><details class="api-request"><summary>API request</summary><a href="${escapeHtml(arrivalsUrl)}" target="_blank" rel="noopener noreferrer">Open raw arrivals response</a><code>${escapeHtml(arrivalsUrl)}</code><p>Eastbound is not an API parameter; this request returns all arrivals for the StopPoint.</p></details></div>
        <div class="board-actions"><button class="secondary-button" type="button" data-refresh-station="${escapeHtml(station.id)}" data-location="${location}">Refresh</button><button class="remove-button" type="button" data-remove-station="${escapeHtml(station.id)}" data-location="${location}">Remove</button></div>
    </div>`;
}

async function createStationBoard(station, location) {
    const board = document.createElement("article");
    board.className = "station-board";
    board.dataset.stationId = station.id;
    board.innerHTML = `${stationBoardHeader(station, location)}<p class="loading-message">Loading live departures...</p>`;
    try {
        const arrivals = await getTrainArrivals(station);
        const needsElizabethDirectionUpdate = station.line === "elizabeth"
            && !["inbound", "outbound"].includes(String(station.direction || "").toLowerCase());
        board.innerHTML = stationBoardHeader(station, location) + (arrivals.length ? arrivals.map(train => `
            <div class="departure-row">
                <div class="route-badge">${escapeHtml((train.lineName || titleCase(station.line)).slice(0, 3))}</div>
                <div class="departure-destination"><strong>${escapeHtml(train.destinationName || train.towards || "Destination unavailable")}</strong><span>${escapeHtml(train.currentLocation || train.towards || "Live prediction")}</span><span class="line-pill">${escapeHtml(titleCase(station.line))}</span></div>
                <div class="departure-platform">${escapeHtml(train.platformName || "Platform unavailable")}</div>
                <div class="departure-time">${formatMinutes(train.timeToStation)}</div>
            </div>`).join("") : needsElizabethDirectionUpdate
                ? `<p class="error-message">This saved Elizabeth line selection uses the old direction setting. Remove and re-add it, then choose Inbound or Outbound.</p>`
                : `<p class="empty-message">No live ${escapeHtml(station.direction)} departures are currently reported for this line.</p>`);
    } catch (error) {
        console.error(error);
        board.innerHTML = `${stationBoardHeader(station, location)}<p class="error-message">Live departures could not be loaded. Check the station and line selection.</p>`;
    }
    updateTrainLineStatus(board, station);
    setupCollapsibleSection(board);
    return board;
}

async function loadStationBoards(location) {
    const container = document.getElementById(`${location}-trains`);
    const stations = config[location].stations;
    if (!stations.length) {
        container.innerHTML = `<p class="empty-message">No ${titleCase(location)} stations have been added.</p>`;
        return;
    }
    const migrated = (await Promise.all(stations.map(async station => {
        if (!station.stopId.startsWith("HUB")) return false;
        const stopPoint = await resolveLineStopPoint({ id: station.stopId }, station.line, station.stationName);
        if (stopPoint.id === station.stopId) return false;
        station.stopId = stopPoint.id;
        return true;
    }))).some(Boolean);
    if (migrated) saveConfig();
    container.innerHTML = `<p class="loading-message">Updating live train arrivals...</p>`;
    container.replaceChildren(...await Promise.all(stations.map(station => createStationBoard(station, location))));
}

function removeItem(location, collection, id) {
    config[location][collection] = config[location][collection].filter(item => item.id !== id);
    saveConfig();
    return collection === "busStops" ? loadBusBoards(location) : loadStationBoards(location);
}

async function refreshSingle(location, collection, id) {
    const item = config[location][collection].find(entry => entry.id === id);
    if (!item) return;
    const selector = collection === "busStops" ? `[data-bus-id="${CSS.escape(id)}"]` : `[data-station-id="${CSS.escape(id)}"]`;
    const oldBoard = document.querySelector(selector);
    const newBoard = collection === "busStops" ? await createBusBoard(item, location) : await createStationBoard(item, location);
    oldBoard?.replaceWith(newBoard);
}

function updateTimestamp() {
    const element = document.getElementById("last-updated");
    if (element) element.textContent = `Last updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

async function refreshAll() {
    await Promise.all([
        loadBusBoards("home"), loadBusBoards("work"),
        loadStationBoards("home"), loadStationBoards("work"),
        loadC2cBoards()
    ]);
    updateTimestamp();
}

async function loadC2cDirection(from, to, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = `<p class="loading-message">Loading c2c departures...</p>`;
    try {
        const response = await fetch(`${C2C_PROXY_BASE}/departures?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "c2c departures could not be loaded.");
        if (!data.departures.length) {
            container.innerHTML = `<p class="empty-message">No live c2c departures are currently reported.</p>`;
            return;
        }
        container.innerHTML = `<div class="c2c-table-scroll"><table class="c2c-departures-table">
            <thead><tr><th>Time</th><th>Service</th><th>Platform</th><th>Status</th></tr></thead>
            <tbody>${data.departures.map(departure => {
                const statusClass = /cancel/i.test(departure.status) ? "cancelled" : /delay|late/i.test(departure.status) ? "delayed" : "";
                return `<tr><td>${escapeHtml(departure.time)}</td><td>${escapeHtml(departure.service)}</td><td>${escapeHtml(departure.platform || "Not listed")}</td><td class="${statusClass}">${escapeHtml(departure.status)}</td></tr>`;
            }).join("")}</tbody>
        </table></div>`;
    } catch (error) {
        console.error(`c2c departures ${from}-${to} could not be loaded.`, error);
        container.innerHTML = `<p class="error-message">c2c departures are unavailable. Check the Worker deployment and try again.</p>`;
    }
}

async function loadC2cBoards() {
    await Promise.all([
        loadC2cHome(),
        loadC2cWork()
    ]);
}

function loadC2cHome() {
    return loadC2cDirection("UPM", "FST", "home-c2c-upminster");
}

function loadC2cWork() {
    return loadC2cDirection("FST", "UPM", "work-c2c-fenchurch");
}

function activateLocation(location, moveFocus = false) {
    const tabs = Array.from(document.querySelectorAll(".location-tab"));
    for (const tab of tabs) {
        const isActive = tab.dataset.location === location;
        tab.setAttribute("aria-selected", String(isActive));
        tab.tabIndex = isActive ? 0 : -1;
        document.getElementById(tab.getAttribute("aria-controls")).hidden = !isActive;
    }
    if (moveFocus) document.getElementById(`${location}-tab`).focus();
}

function updateStationDirectionOptions(lineSelect, directionSelect) {
    if (!lineSelect || !directionSelect) return;
    const previousDirection = directionSelect.value;
    const directions = lineSelect.value === "elizabeth"
        ? [["", "Select direction"], ["inbound", "Inbound"], ["outbound", "Outbound"]]
        : lineSelect.value === "london-overground"
        ? [
            ["", "Select direction"], ["Eastbound", "Eastbound"],
            ["east-west", "Eastbound and Westbound"], ["Westbound", "Westbound"],
            ["Northbound", "Northbound"], ["Southbound", "Southbound"],
            ["Clockwise", "Clockwise"], ["Anti-clockwise", "Anti-clockwise"]
        ]
        : [
            ["", "Select direction"], ["Eastbound", "Eastbound"], ["Westbound", "Westbound"],
            ["Northbound", "Northbound"], ["Southbound", "Southbound"],
            ["Clockwise", "Clockwise"], ["Anti-clockwise", "Anti-clockwise"]
        ];
    directionSelect.replaceChildren(...directions.map(([value, label]) => new Option(label, value)));
    if (directions.some(([value]) => value === previousDirection)) directionSelect.value = previousDirection;
}

function registerEvents() {
    const setupFileInput = document.getElementById("setup-file-input");
    document.getElementById("save-setup")?.addEventListener("click", exportSetup);
    document.getElementById("load-default-setup")?.addEventListener("click", loadSuppliedSetup);
    document.getElementById("load-setup")?.addEventListener("click", () => setupFileInput?.click());
    setupFileInput?.addEventListener("change", async () => {
        const file = setupFileInput.files?.[0];
        setupFileInput.value = "";
        if (file) await importSetup(file);
    });

    const tabs = Array.from(document.querySelectorAll(".location-tab"));
    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => activateLocation(tab.dataset.location));
        tab.addEventListener("keydown", event => {
            let nextIndex;
            if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
            else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
            else if (event.key === "Home") nextIndex = 0;
            else if (event.key === "End") nextIndex = tabs.length - 1;
            else return;

            event.preventDefault();
            activateLocation(tabs[nextIndex].dataset.location, true);
        });
    });

    for (const location of ["home", "work"]) {
        const lineSelect = document.getElementById(`${location}-line`);
        const directionSelect = document.getElementById(`${location}-direction`);
        lineSelect?.addEventListener("change", () => updateStationDirectionOptions(lineSelect, directionSelect));
        updateStationDirectionOptions(lineSelect, directionSelect);

        document.getElementById(`${location}-bus-form`)?.addEventListener("submit", event => {
            event.preventDefault(); addBusStop(location);
        });
        document.getElementById(`${location}-station-form`)?.addEventListener("submit", event => {
            event.preventDefault(); addStation(location);
        });
        document.getElementById(`refresh-${location}-buses`)?.addEventListener("click", async () => {
            await loadBusBoards(location); updateTimestamp();
        });
        document.getElementById(`refresh-${location}-trains`)?.addEventListener("click", async () => {
            await loadStationBoards(location); updateTimestamp();
        });
    }

    document.getElementById("refresh-home-c2c")?.addEventListener("click", async () => {
        await loadC2cHome(); updateTimestamp();
    });
    document.getElementById("refresh-work-c2c")?.addEventListener("click", async () => {
        await loadC2cWork(); updateTimestamp();
    });

    document.addEventListener("click", event => {
        const removeBus = event.target.closest("[data-remove-bus]");
        if (removeBus) return removeItem(removeBus.dataset.location, "busStops", removeBus.dataset.removeBus);
        const removeStation = event.target.closest("[data-remove-station]");
        if (removeStation) return removeItem(removeStation.dataset.location, "stations", removeStation.dataset.removeStation);
        const refreshBus = event.target.closest("[data-refresh-bus]");
        if (refreshBus) return refreshSingle(refreshBus.dataset.location, "busStops", refreshBus.dataset.refreshBus);
        const refreshStation = event.target.closest("[data-refresh-station]");
        if (refreshStation) return refreshSingle(refreshStation.dataset.location, "stations", refreshStation.dataset.refreshStation);
    });
}

function initialise() {
    loadConfig();
    setupCollapsibleSections();
    registerEvents();
    refreshAll();
    window.setInterval(refreshAll, REFRESH_INTERVAL_MS);
}

document.addEventListener("DOMContentLoaded", initialise);
