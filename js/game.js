// game.js
// Ansvar: applikationens state, tur-/AP-motorn (den enda plats som får
// avsluta en spelares tur), samt huvudlyssnaren som binder ihop alla
// moduler. Detta är enda filen som känner till "hela bilden".

import { paths, dbGet, dbUpdate, dbListen, dbTransactPlayer } from "./firebase.js";
import { cityMapData, isStreetTile, isPortTile } from "./map.js";
import { createRoom, joinRoom, assignRolesAndStart, isPolice } from "./players.js";
import { movePlayer } from "./movement.js";
import { directFightOrArrest, blindSearchTile, canFightHere, getValidCombatTargets } from "./combat.js";
import { getBoozeFromPort, handleTurnStartIncome } from "./economy.js";
import * as ui from "./ui.js";

// --- Modul-state (enda källan till sanning för klientens session) ---
let currentRoomCode = null;
let myPlayerId = null;
let amILeader = false;
let stopRoomListener = null;
let insideTurnStartTrigger = false; // förhindrar att turstarts-inkomst triggas flera gånger per tur

// Löpnummer för senaste mottagna rumshändelse. Med flera spelare aktiva
// samtidigt kan flera async-anrop till handlePlayingState överlappa —
// utan detta kunde ett äldre, långsammare anrop hinna klart EFTER ett
// nyare och då rita skärmen med inaktuell data (spelaren såg markören
// "fastna" trots att positionen i databasen redan var korrekt).
let latestEventSeq = 0;

// ---------- Tur-/AP-motorn ----------

/**
 * Enda platsen i hela appen som drar AP och (vid behov) lämnar över turen.
 * Körs som en Firebase-transaktion på spelarens nod: löser den bugg där
 * snabba dubbelklick eller dålig uppkoppling kunde ge felaktiga AP-avdrag.
 * `fieldUpdates` är övriga fält (cash/booze/x/y) som ska sättas samtidigt.
 */
export async function consumeActionPoint(roomCode, playerId, fieldUpdates = {}) {
    const updated = await dbTransactPlayer(roomCode, playerId, (current) => ({
        ...current,
        ...fieldUpdates,
        ap: Math.max(0, current.ap - 1),
    }));
    if (updated && updated.ap <= 0) {
        await passTurnToNext(roomCode, playerId);
    }
}

/**
 * Läser ALLTID en färsk spelarlista direkt från servern (inte en lokalt
 * cachad kopia) innan turordningen beräknas — löser buggen där turen
 * kunde hoppa fel eller låsa sig pga inaktuell data.
 */
async function passTurnToNext(roomCode, currentPlayerId) {
    const players = await dbGet(paths.players(roomCode));
    if (!players) return;
    const ids = Object.keys(players);
    if (ids.length === 0) return;
    const idx = ids.indexOf(currentPlayerId);
    const nextId = ids[(idx + 1) % ids.length];

    await dbUpdate({
        [paths.currentTurn(roomCode)]: nextId,
        [`${paths.player(roomCode, nextId)}/ap`]: 3,
    });
}

// ---------- Rumsflöde ----------

export async function handleCreateRoom(hostName) {
    const { roomCode, playerId, isLeader } = await createRoom(hostName);
    currentRoomCode = roomCode;
    myPlayerId = playerId;
    amILeader = isLeader;

    ui.setRoomCodeDisplay(roomCode);
    ui.setStartButtonVisible(true);
    ui.showScreen("lobby-screen");
    startListening(roomCode);
}

export async function handleJoinRoom(roomCodeInput, nameInput) {
    if (!roomCodeInput || !nameInput) {
        ui.toast("Fyll i rumskod och namn!", "warning");
        return;
    }
    try {
        const { roomCode, playerId, isLeader } = await joinRoom(roomCodeInput, nameInput);
        currentRoomCode = roomCode;
        myPlayerId = playerId;
        amILeader = isLeader;

        ui.setRoomCodeDisplay(roomCode);
        ui.setStartButtonVisible(false);
        ui.showScreen("lobby-screen");
        startListening(roomCode);
    } catch (err) {
        ui.toast(err.message, "warning");
    }
}

export async function handleStartGame() {
    if (!amILeader || !currentRoomCode) return;
    try {
        await assignRolesAndStart(currentRoomCode);
    } catch (err) {
        ui.toast(err.message, "warning");
    }
}

// ---------- Huvudlyssnare ----------

function startListening(roomCode) {
    if (stopRoomListener) stopRoomListener();
    stopRoomListener = dbListen(paths.room(roomCode), (data) => {
        if (!data) return;

        if (data.players) ui.renderPlayerList(data.players);

        if (data.status === "playing") {
            const mySeq = ++latestEventSeq;
            handlePlayingState(roomCode, data, mySeq);
        }
    });
}

async function handlePlayingState(roomCode, data, mySeq) {
    // Kartan ritas alltid direkt och synkront med den senast mottagna datan,
    // så positionen på skärmen är aldrig fördröjd av något await nedanför.
    ui.showScreen("game-screen");
    ui.renderCityMap(data.players, data.secrets, data.currentTurn, myPlayerId);

    const me = data.players[myPlayerId];
    if (!me) return;

    const isMyTurn = data.currentTurn === myPlayerId;
    const meIsPolice = isPolice(me);
    const mySecret = data.secrets ? data.secrets[myPlayerId] : null;

    // Turstarts-inkomst (klubbförsäljning) — bara en gång per tur.
    if (isMyTurn && !insideTurnStartTrigger) {
        insideTurnStartTrigger = true;
        await handleTurnStartIncome(roomCode, myPlayerId, data);
        // Ett nyare event kan ha kommit in medan vi väntade ovan. Om så är
        // fallet har den redan ritat en färskare bild — avbryt här istället
        // för att skriva över den med denna (nu inaktuella) omgångs data.
        if (mySeq !== latestEventSeq) return;
    }
    if (!isMyTurn) insideTurnStartTrigger = false;

    ui.renderHud(me, mySecret);

    const activeName = data.players[data.currentTurn] ? data.players[data.currentTurn].name : "Någon";
    ui.renderTurnIndicator(isMyTurn, me.ap, activeName);
    ui.toggleMovementControls(isMyTurn);

    ui.hideActionButtons();
    if (!isMyTurn) return;

    wireActionButtons(roomCode, data, me, meIsPolice);
    if (mySeq !== latestEventSeq) return; // se kommentar ovan
}

function wireActionButtons(roomCode, data, me, meIsPolice) {
    const targetsOnTile = Object.entries(data.players).filter(
        ([id, p]) => id !== myPlayerId && p.x === me.x && p.y === me.y
    );
    const validCombatTargets = getValidCombatTargets(meIsPolice, targetsOnTile.map(([, p]) => p));

    // Primär knapp: hämta sprit i hamnen (bara gäng, bara på hamn-rutan).
    if (!meIsPolice && isPortTile(me.x, me.y)) {
        ui.setActionButton(1, {
            visible: true,
            className: "btn-success",
            label: "⚓ Hämta Sprit (1 AP)",
            onClick: () => getBoozeFromPort(roomCode, myPlayerId),
        });
    } else if (validCombatTargets.length > 0 && canFightHere(me.x, me.y)) {
        // REGEL: gäng kan inte utmana polis, och ingen slåss i hamnen (hanteras i combat.js).
        ui.setActionButton(1, {
            visible: true,
            className: meIsPolice ? "btn-police" : "btn-gang",
            label: meIsPolice ? "👮 Haffa Någon (1 AP)" : "💥 Slagsmål (1 AP)",
            onClick: () => directFightOrArrest(roomCode, myPlayerId, me.x, me.y),
        });
    }

    // Sekundär knapp: sök lönnkrog / razzia på gaturutor.
    const tile = cityMapData.find((t) => t.x === me.x && t.y === me.y);
    if (isStreetTile(tile)) {
        ui.setActionButton(2, {
            visible: true,
            className: meIsPolice ? "btn-police" : "btn-gang",
            label: meIsPolice ? "🚨 Razzia (1 AP)" : "🪑 Sök lönnkrog (1 AP)",
            onClick: () => blindSearchTile(roomCode, myPlayerId, me.x, me.y),
        });
    }
}

// ---------- DOM-inbindning (entry point) ----------

function init() {
    ui.showScreen("start-screen");

    document.getElementById("create-room-btn").addEventListener("click", () => {
        ui.showScreen("host-name-screen");
    });

    document.getElementById("confirm-create-room-btn").addEventListener("click", () => {
        const name = document.getElementById("host-name-input").value;
        if (!name.trim()) {
            ui.toast("Ange ditt namn först!", "warning");
            return;
        }
        handleCreateRoom(name);
    });

    document.getElementById("join-setup-btn").addEventListener("click", () => {
        ui.showScreen("join-screen");
    });

    document.getElementById("execute-join-btn").addEventListener("click", () => {
        const code = document.getElementById("join-code-input").value;
        const name = document.getElementById("join-name-input").value;
        handleJoinRoom(code, name);
    });

    document.getElementById("go-back-btn").addEventListener("click", () => {
        ui.showScreen("start-screen");
    });
    document.getElementById("go-back-btn-2").addEventListener("click", () => {
        ui.showScreen("start-screen");
    });

    document.getElementById("start-game-btn").addEventListener("click", handleStartGame);

    document.querySelectorAll(".dpad-btn[data-dx]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const dx = parseInt(btn.dataset.dx, 10);
            const dy = parseInt(btn.dataset.dy, 10);
            movePlayer(currentRoomCode, myPlayerId, dx, dy);
        });
    });
}

document.addEventListener("DOMContentLoaded", init);
