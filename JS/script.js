"use strict";

const STORAGE_KEY = "tfl-commute-dashboard-v2";
const REFRESH_INTERVAL_MS = 30000;
const TFL_API_BASE = "https://api.tfl.gov.uk";

// Optional: add your TfL API key here for sustained use.
const TFL_APP_KEY = "";

let config = {
    home: { busStops: [], stations: [] },
    work: { busStops: [], stations: [] }
};

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

async function getTrainArrivals(station) {
    const arrivals = await fetchJson(stationArrivalsUrl(station));
    const lineMatches = arrivals.filter(item => {
        const value = String(item.lineId || item.lineName || "").toLowerCase();
        return value === station.line.toLowerCase() || value.includes(station.line.toLowerCase());
    });
    const directionMatchesOnly = lineMatches.filter(item => directionMatches(item, station.direction));
    // TfL does not always expose a compass direction. Prefer exact direction matches;
    // otherwise show line-matched services and expose platform/destination to the user.
    return (directionMatchesOnly.length ? directionMatchesOnly : lineMatches)
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
    return `<div class="board-header">
        <div><h4>${escapeHtml(station.stationName)}</h4><p class="board-subtitle">${escapeHtml(titleCase(station.line))} · ${escapeHtml(station.direction)}</p><p class="line-service-status status-loading" data-line-service-status role="status">Checking service status...</p><details class="api-request"><summary>API request</summary><a href="${escapeHtml(arrivalsUrl)}" target="_blank" rel="noopener noreferrer">Open raw arrivals response</a><code>${escapeHtml(arrivalsUrl)}</code><p>Eastbound is not an API parameter; this request returns all arrivals for the StopPoint.</p></details></div>
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
        board.innerHTML = stationBoardHeader(station, location) + (arrivals.length ? arrivals.map(train => `
            <div class="departure-row">
                <div class="route-badge">${escapeHtml((train.lineName || titleCase(station.line)).slice(0, 3))}</div>
                <div class="departure-destination"><strong>${escapeHtml(train.destinationName || train.towards || "Destination unavailable")}</strong><span>${escapeHtml(train.currentLocation || train.towards || "Live prediction")}</span><span class="line-pill">${escapeHtml(titleCase(station.line))}</span></div>
                <div class="departure-platform">${escapeHtml(train.platformName || "Platform unavailable")}</div>
                <div class="departure-time">${formatMinutes(train.timeToStation)}</div>
            </div>`).join("") : `<p class="empty-message">No live ${escapeHtml(station.direction)} departures are currently reported for this line.</p>`);
    } catch (error) {
        console.error(error);
        board.innerHTML = `${stationBoardHeader(station, location)}<p class="error-message">Live departures could not be loaded. Check the station and line selection.</p>`;
    }
    updateTrainLineStatus(board, station);
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
        loadStationBoards("home"), loadStationBoards("work")
    ]);
    updateTimestamp();
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

function registerEvents() {
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
    registerEvents();
    refreshAll();
    window.setInterval(refreshAll, REFRESH_INTERVAL_MS);
}

document.addEventListener("DOMContentLoaded", initialise);
