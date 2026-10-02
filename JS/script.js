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
    const target = stationName.toLowerCase().replace(/\s+(station|underground|rail)$/g, "").trim();
    return matches.find(match => (match.name || "").toLowerCase().replace(/\s+(station|underground|rail)$/g, "").trim() === target)
        || matches.find(match => (match.modes || []).some(mode => String(mode).includes(line)))
        || matches[0];
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

async function getTrainArrivals(station) {
    const arrivals = await fetchJson(`${TFL_API_BASE}/StopPoint/${encodeURIComponent(station.stopId)}/Arrivals`);
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

function stationBoardHeader(station, location) {
    return `<div class="board-header">
        <div><h4>${escapeHtml(station.stationName)}</h4><p class="board-subtitle">${escapeHtml(titleCase(station.line))} · ${escapeHtml(station.direction)}</p></div>
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
    return board;
}

async function loadStationBoards(location) {
    const container = document.getElementById(`${location}-trains`);
    const stations = config[location].stations;
    if (!stations.length) {
        container.innerHTML = `<p class="empty-message">No ${titleCase(location)} stations have been added.</p>`;
        return;
    }
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

function registerEvents() {
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
