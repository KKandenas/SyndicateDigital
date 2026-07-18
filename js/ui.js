// ui.js
// Ansvar: ALL direkt DOM-manipulation. Andra moduler ska aldrig röra
// document.* själva — de anropar funktioner härifrån.

import { cityMapData } from "./map.js";
import { isPolice } from "./players.js";

const MAX_BOOZE = 3;
const MAX_AP = 3;
const TILE_COUNT = 5;

// --- Syndikat: symbol, CSS-klass och färg på ett ställe, delas mellan
// spelbrickorna på kartan och HUD-ramens färg. ---
const SYNDICATES = [
    { match: "Nightspades", tokenClass: "token-spades", symbol: "♠", color: "#2563eb" },
    { match: "Crimson", tokenClass: "token-hearts", symbol: "♥", color: "#dc2626" },
    { match: "Clovers", tokenClass: "token-clovers", symbol: "♣", color: "#16a34a" },
    { match: "Diamond", tokenClass: "token-diamonds", symbol: "♦", color: "#d97706" },
];
const POLICE_INFO = { tokenClass: "token-police", symbol: "🚨", color: "#4f46e5" };
const FALLBACK_INFO = { tokenClass: "token-police", symbol: "❓", color: "#4f46e5" };

function syndicateInfo(p) {
    if (isPolice(p)) return POLICE_INFO;
    return SYNDICATES.find((s) => p.syndicate && p.syndicate.includes(s.match)) || FALLBACK_INFO;
}

// --- Skärmar ---
export function showScreen(screenId) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    document.getElementById(screenId).classList.add("active");
}

// --- Toast (ersätter alert()) ---
let toastContainer = null;
export function toast(message, variant = "info", durationMs = 3600) {
    if (!toastContainer) {
        toastContainer = document.getElementById("toast-container");
    }
    const el = document.createElement("div");
    el.className = `toast toast-${variant}`;
    el.innerText = message;
    toastContainer.appendChild(el);

    requestAnimationFrame(() => el.classList.add("toast-visible"));
    setTimeout(() => {
        el.classList.remove("toast-visible");
        setTimeout(() => el.remove(), 300);
    }, durationMs);
}

// --- Lobby ---
export function renderPlayerList(playersObj) {
    const listEl = document.getElementById("player-list-box");
    if (!listEl) return;
    listEl.innerHTML = "";
    for (const id in playersObj) {
        const p = playersObj[id];
        listEl.innerHTML += `<div class="player-item"><span>👤 ${escapeHtml(p.name)}</span></div>`;
    }
}

export function setRoomCodeDisplay(code) {
    document.getElementById("display-code").innerText = code;
}

export function setStartButtonVisible(visible) {
    document.getElementById("start-game-btn").style.display = visible ? "block" : "none";
}

// --- Karta ---
// Kartrutorna byggs EN gång (statisk layout) och återanvänds sedan. Spelar-
// brickorna ligger i ett eget absolut-positionerat lager ovanpå och flyttas
// (inte återskapas) mellan renderingar, vilket gör att CSS kan animera
// glidningen mellan rutor istället för att bara "hoppa" varje gång.
let mapSkeletonBuilt = false;
const tokenEls = {};

// Enkel spridning av flera brickor som råkar dela ruta, så de inte helt
// överlappar varandra.
const STACK_OFFSETS = [
    [0, 0], [-8, -6], [8, -6], [-8, 6], [8, 6], [0, 9],
];

export function renderCityMap(players, secrets, currentTurnId, myPlayerId) {
    ensureMapSkeleton();
    updateSecretOverlays(secrets, myPlayerId);
    updatePlayerTokens(players || {}, currentTurnId, myPlayerId);
}

function ensureMapSkeleton() {
    if (mapSkeletonBuilt) return;
    const boardEl = document.getElementById("map-board");
    boardEl.innerHTML = "";

    const tilesLayer = document.createElement("div");
    tilesLayer.className = "map-tiles";
    cityMapData.forEach((tile) => {
        const tileDiv = document.createElement("div");
        tileDiv.className = `map-tile tile-${tile.type}`;
        tileDiv.dataset.x = tile.x;
        tileDiv.dataset.y = tile.y;
        tileDiv.innerHTML = `<div class="tile-title">${escapeHtml(tile.name)}</div><div class="secret-overlay-slot"></div>`;
        tilesLayer.appendChild(tileDiv);
    });

    const tokenLayer = document.createElement("div");
    tokenLayer.className = "token-layer";
    tokenLayer.id = "token-layer";

    boardEl.appendChild(tilesLayer);
    boardEl.appendChild(tokenLayer);
    mapSkeletonBuilt = true;
}

function updateSecretOverlays(secrets, myPlayerId) {
    const mySecret = secrets ? secrets[myPlayerId] : null;
    document.querySelectorAll("#map-board .map-tile").forEach((tileDiv) => {
        const x = Number(tileDiv.dataset.x);
        const y = Number(tileDiv.dataset.y);
        const slot = tileDiv.querySelector(".secret-overlay-slot");

        let html = "";
        if (mySecret) {
            if (mySecret.club && mySecret.club.x === x && mySecret.club.y === y) {
                html = `<div class="secret-overlay overlay-club"><span>🍸</span><span class="overlay-text">Klubb (${mySecret.club.stock || 0})</span></div>`;
            } else if (mySecret.stash && mySecret.stash.x === x && mySecret.stash.y === y) {
                html = `<div class="secret-overlay overlay-stash"><span>💰</span><span class="overlay-text">Gömma</span></div>`;
            }
        }
        if (slot.innerHTML !== html) slot.innerHTML = html;
    });
}

function updatePlayerTokens(players, currentTurnId, myPlayerId) {
    const layer = document.getElementById("token-layer");
    if (!layer) return;

    const byTile = {};
    Object.keys(players).sort().forEach((id) => {
        const p = players[id];
        const key = `${p.x},${p.y}`;
        (byTile[key] = byTile[key] || []).push(id);
    });

    const seen = new Set();
    for (const key in byTile) {
        byTile[key].forEach((id, idx) => {
            seen.add(id);
            const p = players[id];
            let el = tokenEls[id];
            if (!el) {
                el = document.createElement("div");
                el.className = "player-token";
                layer.appendChild(el);
                tokenEls[id] = el;
            }
            positionToken(el, p.x, p.y, idx);
            styleToken(el, p, id, currentTurnId, myPlayerId);
        });
    }

    // Ta bort brickor för spelare som inte längre finns i rummet.
    for (const id in tokenEls) {
        if (!seen.has(id)) {
            tokenEls[id].remove();
            delete tokenEls[id];
        }
    }
}

function positionToken(el, x, y, stackIndex) {
    const cellPct = 100 / TILE_COUNT;
    const centerX = x * cellPct + cellPct / 2;
    const centerY = y * cellPct + cellPct / 2;
    const [ox, oy] = STACK_OFFSETS[stackIndex % STACK_OFFSETS.length];
    el.style.left = `calc(${centerX}% + ${ox}px)`;
    el.style.top = `calc(${centerY}% + ${oy}px)`;
}

function styleToken(el, p, id, currentTurnId, myPlayerId) {
    const info = syndicateInfo(p);

    el.className = `player-token ${info.tokenClass}`;
    el.classList.toggle("token-me", id === myPlayerId);
    el.classList.toggle("token-active-turn", id === currentTurnId);

    el.innerHTML = `<span class="token-symbol">${info.symbol}</span>`;
    el.title = p.name;
    el.setAttribute("aria-label", `${p.name} (${isPolice(p) ? "Polis" : p.syndicate})`);
    el.onclick = () => toast(`${info.symbol} ${p.name} — ${isPolice(p) ? "Polis" : p.syndicate}`, isPolice(p) ? "police" : "gang", 2200);
}

// --- HUD ---
let lastCash = null;
let lastBank = null;
let lastBooze = null;

function flashChange(el, newVal, prevVal) {
    if (!el || prevVal === null || newVal === prevVal) return;
    const cls = newVal > prevVal ? "hud-flash-up" : "hud-flash-down";
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 500);
}

function renderPips(current, max, variantClass) {
    let out = "";
    for (let i = 0; i < max; i++) {
        out += `<span class="pip ${variantClass}${i < current ? " pip-filled" : ""}"></span>`;
    }
    return out;
}

export function renderHud(me, mySecret) {
    const meIsPolice = isPolice(me);
    const info = syndicateInfo(me);

    const gangItemEl = document.getElementById("hud-gang-item");
    if (gangItemEl) gangItemEl.style.borderLeftColor = info.color;
    document.getElementById("hud-gang").innerText = `${info.symbol} ${me.syndicate}`;

    const boozeEl = document.getElementById("hud-booze");
    if (meIsPolice) {
        boozeEl.innerText = `🚨 Beslag: ${me.booze}`;
    } else {
        boozeEl.innerHTML = `📦 <span class="pip-row">${renderPips(me.booze, MAX_BOOZE, "pip-booze")}</span> ${me.booze}/${MAX_BOOZE}`;
    }
    flashChange(boozeEl, me.booze, lastBooze);
    lastBooze = me.booze;

    const cashEl = document.getElementById("hud-cash");
    cashEl.innerText = `💵 Fickan: $${me.cash}`;
    flashChange(cashEl, me.cash, lastCash);
    lastCash = me.cash;

    const bankHud = document.getElementById("hud-bank");
    if (meIsPolice) {
        bankHud.innerText = `🏦 Polisens Statskassa: $${me.bank}`;
        bankHud.style.background = "#131c2e";
    } else {
        const clubStock = mySecret && mySecret.club ? (mySecret.club.stock || 0) : 0;
        const clubCash = mySecret && mySecret.club ? (mySecret.club.clubCash || 0) : 0;
        bankHud.innerText = `🏦 Säkrat: $${me.bank} | 🍸 Klubb-lager: ${clubStock} st ($${clubCash})`;
        bankHud.style.background = "#132316";
    }
    flashChange(bankHud, me.bank, lastBank);
    lastBank = me.bank;
}

let wasMyTurn = false;
export function renderTurnIndicator(isMyTurn, apLeft, activeName) {
    const el = document.getElementById("turn-indicator");
    if (isMyTurn) {
        el.innerHTML = `<span>DIN TUR!</span><span class="pip-row">${renderPips(apLeft, MAX_AP, "pip-ap")}</span>`;
        el.className = "turn-indicator turn-active";
        if (!wasMyTurn) {
            el.classList.add("turn-just-started");
            setTimeout(() => el.classList.remove("turn-just-started"), 500);
        }
    } else {
        el.innerHTML = `<span>Väntar på ${escapeHtml(activeName)}...</span>`;
        el.className = "turn-indicator";
    }
    wasMyTurn = isMyTurn;
}

export function toggleMovementControls(enable) {
    document.querySelectorAll(".dpad-btn").forEach((btn) => (btn.disabled = !enable));
}

// --- Aktionsknappar (primär/sekundär) ---
export function setActionButton(slot, { visible, className, label, onClick }) {
    const btn = document.getElementById(slot === 1 ? "primary-action-btn" : "secondary-action-btn");
    if (!visible) {
        btn.style.display = "none";
        btn.onclick = null;
        return;
    }
    btn.style.display = "block";
    btn.className = className;
    btn.innerText = label;
    btn.onclick = onClick;
}

export function hideActionButtons() {
    setActionButton(1, { visible: false });
    setActionButton(2, { visible: false });
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.innerText = str;
    return div.innerHTML;
}
