// ui.js
// Ansvar: ALL direkt DOM-manipulation. Andra moduler ska aldrig röra
// document.* själva — de anropar funktioner härifrån.

import { cityMapData } from "./map.js";
import { isPolice } from "./players.js";

const MAX_BOOZE = 3;

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
export function renderCityMap(players, secrets, myPlayerId) {
    const boardEl = document.getElementById("map-board");
    boardEl.innerHTML = "";

    const me = players[myPlayerId];
    const meIsPolice = isPolice(me);

    cityMapData.forEach((tile) => {
        const tileDiv = document.createElement("div");
        tileDiv.className = `map-tile tile-${tile.type}`;

        let secretHTML = "";
        if (!meIsPolice && secrets && secrets[myPlayerId]) {
            const mySec = secrets[myPlayerId];
            if (mySec.club && mySec.club.x === tile.x && mySec.club.y === tile.y) {
                secretHTML = `<div class="secret-overlay overlay-club"><span>🍸</span><span class="overlay-text">Klubb (${mySec.club.stock || 0})</span></div>`;
            }
            if (mySec.stash && mySec.stash.x === tile.x && mySec.stash.y === tile.y) {
                secretHTML = `<div class="secret-overlay overlay-stash"><span>💰</span><span class="overlay-text">Gömma</span></div>`;
            }
        }

        let presenceHTML = "";
        for (const id in players) {
            const p = players[id];
            if (p.x === tile.x && p.y === tile.y) {
                presenceHTML += playerTokenHTML(p, id === myPlayerId);
            }
        }

        tileDiv.innerHTML = `<div class="tile-title">${tile.name}</div>${secretHTML}<div class="presence-container">${presenceHTML}</div>`;
        boardEl.appendChild(tileDiv);
    });
}

function playerTokenHTML(p, isMe) {
    let tClass = "token-police";
    let sym = "🚨";
    if (isPolice(p)) {
        tClass = "token-police"; sym = "🚨";
    } else if (p.syndicate.includes("Nightspades")) { tClass = "token-spades"; sym = "♠"; }
    else if (p.syndicate.includes("Crimson")) { tClass = "token-hearts"; sym = "♥"; }
    else if (p.syndicate.includes("Clovers")) { tClass = "token-clovers"; sym = "♣"; }
    else if (p.syndicate.includes("Diamond")) { tClass = "token-diamonds"; sym = "♦"; }

    const meClass = isMe ? " token-me" : "";
    return `<div class="player-token ${tClass}${meClass}"><span class="token-symbol">${sym}</span><span>${escapeHtml(p.name.charAt(0).toUpperCase())}</span></div>`;
}

// --- HUD ---
export function renderHud(me, mySecret) {
    const meIsPolice = isPolice(me);

    document.getElementById("hud-gang").innerText = me.syndicate;
    document.getElementById("hud-booze").innerText = meIsPolice
        ? `🚨 Beslag: ${me.booze}`
        : `📦 Sprit: ${me.booze}/${MAX_BOOZE}`;
    document.getElementById("hud-cash").innerText = `💵 Fickan: $${me.cash}`;

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
}

export function renderTurnIndicator(isMyTurn, apLeft, activeName) {
    const el = document.getElementById("turn-indicator");
    if (isMyTurn) {
        el.innerText = `DIN TUR! Kvar: ${apLeft} AP`;
        el.className = "turn-indicator turn-active";
    } else {
        el.innerText = `Väntar på ${activeName}...`;
        el.className = "turn-indicator";
    }
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
