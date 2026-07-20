// game.js
// Ansvar: applikationens state, tur-/AP-motorn (den enda plats som får
// avsluta en spelares tur), samt huvudlyssnaren som binder ihop alla
// moduler. Detta är enda filen som känner till "hela bilden".

import { paths, dbGet, dbUpdate, dbUpdateAt, dbListen, dbTransactPlayer, dbClaimOnce, registerPresence } from "./firebase.js";
import { cityMapData, isOpenTile, isPortTile } from "./map.js";
import { createRoom, joinRoom, assignRolesAndStart, isPolice } from "./players.js";
import { movePlayer } from "./movement.js";
import { directFightOrArrest, blindSearchTile, canFightHere, getValidCombatTargets } from "./combat.js";
import { getBoozeFromPort, handleTurnStartIncome } from "./economy.js";
import { GANG_WIN_CASH, POLICE_WIN_CASH, POLICE_WIN_BUSTS } from "./rules.js";
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

// ---------- Session (överlever sidladdning) ----------

// Sparar bara rums-/spelar-ID — inget känsligt — så en spelare som råkar
// ladda om fliken (eller får den bakgrundad/avdödad av iOS) kan återuppta
// SAMMA spelare istället för att bli en ny en. localStorage kan vara
// otillgängligt (privat läge m.m.); allt nedan degraderar tyst om så.
const SESSION_KEY = "noir-syndicate-session";

function saveSession(roomCode, playerId) {
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, playerId }));
    } catch { /* inget lokalt lagringsutrymme tillgängligt — inte kritiskt */ }
}

function clearSession() {
    try {
        localStorage.removeItem(SESSION_KEY);
    } catch { /* se ovan */ }
}

function loadSession() {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

/**
 * Körs en gång vid sidladdning. Om det finns en sparad session och rummet/
 * spelaren fortfarande finns kvar (och spelet inte redan avgjorts), återupp-
 * tas den — annars städas sessionen bort tyst och startskärmen visas som
 * vanligt.
 */
async function attemptResumeSession() {
    const session = loadSession();
    if (!session) return;

    const room = await dbGet(paths.room(session.roomCode));
    const player = room && room.players ? room.players[session.playerId] : null;

    if (!room || !player || room.winner) {
        clearSession();
        return;
    }

    currentRoomCode = session.roomCode;
    myPlayerId = session.playerId;
    amILeader = !!player.isLeader;

    await dbUpdateAt(paths.player(session.roomCode, session.playerId), { connected: true });
    registerPresence(session.roomCode, session.playerId);

    ui.setRoomCodeDisplay(session.roomCode);
    ui.setStartButtonVisible(amILeader);
    ui.showScreen(room.status === "playing" ? "game-screen" : "lobby-screen");
    startListening(session.roomCode);
    ui.toast("🔌 Återansluten till spelet.", "success");
}

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

    const nextId = findNextConnectedPlayer(players, ids, currentPlayerId);
    if (!nextId) return; // ingen ansluten spelare kvar — inget att lämna över till

    await dbUpdate({
        [paths.currentTurn(roomCode)]: nextId,
        [`${paths.player(roomCode, nextId)}/ap`]: 3,
    });
}

/**
 * Hoppar över spelare markerade `connected: false` (se registerPresence i
 * firebase.js) i turordningen, så att spelet inte låser sig för alltid bara
 * för att någon stänger fliken eller tappar täckning mitt i sin tur.
 * `undefined` räknas som anslutet, för gamla spelarposter utan fältet.
 */
function findNextConnectedPlayer(players, ids, fromId) {
    const startIdx = ids.indexOf(fromId);
    for (let step = 1; step <= ids.length; step++) {
        const candidateId = ids[(startIdx + step) % ids.length];
        if (players[candidateId].connected !== false) return candidateId;
    }
    return null;
}

// ---------- Rumsflöde ----------

export async function handleCreateRoom(hostName) {
    try {
        const { roomCode, playerId, isLeader } = await createRoom(hostName);
        currentRoomCode = roomCode;
        myPlayerId = playerId;
        amILeader = isLeader;
        saveSession(roomCode, playerId);

        ui.setRoomCodeDisplay(roomCode);
        ui.setStartButtonVisible(true);
        ui.showScreen("lobby-screen");
        startListening(roomCode);
    } catch (err) {
        ui.toast(err.message || "Kunde inte skapa rummet. Kolla uppkopplingen och försök igen.", "warning");
    }
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
        saveSession(roomCode, playerId);

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

/**
 * Lämnar rummet frivilligt — från lobbyn eller mitt i ett pågående spel.
 * Skriver `connected: false` DIREKT istället för att förlita sig på
 * onDisconnect: vi navigerar bara bort inom samma SPA-flik, så uppkopplingen
 * (och därmed onDisconnect-hooken) bryts inte bara för att skärmen byts.
 * Utan detta skulle övriga spelare aldrig få veta att vi lämnat.
 */
async function handleLeaveRoom() {
    if (currentRoomCode && myPlayerId) {
        try {
            await dbUpdateAt(paths.player(currentRoomCode, myPlayerId), { connected: false });
        } catch { /* nätverksfel — vi lämnar lokalt oavsett */ }
    }
    if (stopRoomListener) stopRoomListener();
    stopRoomListener = null;
    currentRoomCode = null;
    myPlayerId = null;
    clearSession();
    ui.showScreen("start-screen");
}

// ---------- Vinstvillkor ----------

/**
 * Rent beräknad utifrån den delade rumsdatan — alla klienter som tar emot
 * samma `data` kommer alltid fram till samma svar, så det spelar ingen roll
 * VEM som råkar upptäcka det. Se rules.js för själva gränsvärdena.
 */
function computeWinner(data) {
    for (const id in data.players) {
        const p = data.players[id];
        if (!isPolice(p) && p.bank >= GANG_WIN_CASH) {
            return { playerId: id, name: p.name, role: "gang", reason: `${p.syndicate} säkrade $${GANG_WIN_CASH} i sin gömma.` };
        }
    }
    const policeEntry = Object.entries(data.players).find(([, p]) => isPolice(p));
    if (policeEntry) {
        const [policeId, police] = policeEntry;
        if (police.bank >= POLICE_WIN_CASH) {
            return { playerId: policeId, name: police.name, role: "police", reason: `Polisen fyllde statskassan till $${POLICE_WIN_CASH}.` };
        }
        if ((data.policeBusts || 0) >= POLICE_WIN_BUSTS) {
            return { playerId: policeId, name: police.name, role: "police", reason: `Polisen genomförde ${POLICE_WIN_BUSTS} lyckade razzior mot svartklubbar.` };
        }
    }
    return null;
}

/**
 * Körs av VARJE klient på varje rumsuppdatering. `dbClaimOnce` garanterar
 * att bara den första skrivningen någonsin sätter vinnaren, så flera
 * klienter som råkar upptäcka samma villkor samtidigt krockar inte.
 */
async function maybeClaimWinner(roomCode, data) {
    if (data.winner) return;
    const outcome = computeWinner(data);
    if (!outcome) return;
    await dbClaimOnce(paths.winner(roomCode), outcome);
}

// ---------- Frånkopplade spelare ----------

// Håller reda på vilken currentTurn vi senast försökte hoppa förbi, så att
// vi inte upprepar samma toast/skrivning på varje enskild rumsuppdatering
// medan vi väntar på att skrivningen ovan hinner slå igenom.
let handledDisconnectFor = null;

/**
 * Körs av VARJE ansluten klient på varje rumsuppdatering: om spelaren vars
 * tur det är just nu har markerats frånkopplad (onDisconnect i firebase.js),
 * kan de förstås aldrig själva trycka på något — så vilken annan ansluten
 * klient som helst tar över och lämnar turen vidare åt dem.
 */
async function maybeSkipDisconnectedTurn(roomCode, data) {
    const currentId = data.currentTurn;
    const current = data.players[currentId];
    const stuck = !current || current.connected === false;

    if (!stuck) {
        handledDisconnectFor = null;
        return;
    }
    if (handledDisconnectFor === currentId) return;
    handledDisconnectFor = currentId;

    ui.toast(`🔌 ${current ? current.name : "Spelaren"} verkar ha lämnat — turen går vidare.`, "warning");
    await passTurnToNext(roomCode, currentId);
}

// ---------- Huvudlyssnare ----------

function startListening(roomCode) {
    if (stopRoomListener) stopRoomListener();
    stopRoomListener = dbListen(paths.room(roomCode), (data) => {
        if (!data) return;

        if (data.players) {
            const connectedPlayers = Object.fromEntries(
                Object.entries(data.players).filter(([, p]) => p.connected !== false)
            );
            ui.renderPlayerList(connectedPlayers);
        }

        if (data.status === "playing") {
            const mySeq = ++latestEventSeq;
            handlePlayingState(roomCode, data, mySeq);
        }
    });
}

async function handlePlayingState(roomCode, data, mySeq) {
    if (data.winner) {
        ui.showVictoryScreen(data.winner, data.players);
        return;
    }

    // Kartan ritas alltid direkt och synkront med den senast mottagna datan,
    // så positionen på skärmen är aldrig fördröjd av något await nedanför.
    ui.showScreen("game-screen");
    ui.renderCityMap(data.players, data.secrets, data.currentTurn, myPlayerId);

    const me = data.players[myPlayerId];
    if (!me) return;

    // Självläkning: om vi tidigare blivit markerade frånkopplade (t.ex. en
    // kort nätverksblip eller att fliken bakgrundades en stund på iOS) men
    // uppenbarligen tar emot uppdateringar igen, städa upp efter oss själva
    // och registrera presence-hooken på nytt för nästa gång.
    if (me.connected === false) {
        dbUpdateAt(paths.player(roomCode, myPlayerId), { connected: true });
        registerPresence(roomCode, myPlayerId);
    }

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

    ui.renderHud(me, mySecret, data.policeBusts || 0);
    ui.renderLeaderboard(data.players, data.policeBusts || 0, myPlayerId);

    const activeName = data.players[data.currentTurn] ? data.players[data.currentTurn].name : "Någon";
    ui.renderTurnIndicator(isMyTurn, me.ap, activeName);
    ui.toggleMovementControls(isMyTurn);

    ui.hideActionButtons();

    // Görs av alla anslutna klienter, oavsett vems tur det är.
    await maybeSkipDisconnectedTurn(roomCode, data);
    if (mySeq !== latestEventSeq) return;

    // Vinstvillkoren kan uppfyllas av vilken spelares handling som helst.
    await maybeClaimWinner(roomCode, data);
    if (mySeq !== latestEventSeq) return;

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

    // Sekundär knapp: sök lönnkrog / razzia — går på alla öppna rutor,
    // inklusive hörnen (se isOpenTile i map.js).
    const tile = cityMapData.find((t) => t.x === me.x && t.y === me.y);
    if (isOpenTile(tile)) {
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
    attemptResumeSession();

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
    document.getElementById("lobby-leave-btn").addEventListener("click", handleLeaveRoom);
    document.getElementById("rules-leave-btn").addEventListener("click", handleLeaveRoom);

    document.getElementById("rules-btn-start").addEventListener("click", () => {
        ui.setLeaveButtonVisible(false);
        ui.setRulesRoomCode(null);
        ui.openRules();
    });
    document.getElementById("rules-btn-game").addEventListener("click", () => {
        ui.setLeaveButtonVisible(true);
        ui.setRulesRoomCode(currentRoomCode);
        ui.openRules();
    });
    document.getElementById("rules-close-btn").addEventListener("click", ui.closeRules);

    document.getElementById("leaderboard-toggle").addEventListener("click", ui.toggleLeaderboard);

    document.getElementById("victory-home-btn").addEventListener("click", handleLeaveRoom);

    document.querySelectorAll(".dpad-btn[data-dx]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const dx = parseInt(btn.dataset.dx, 10);
            const dy = parseInt(btn.dataset.dy, 10);
            movePlayer(currentRoomCode, myPlayerId, dx, dy);
        });
    });
}

document.addEventListener("DOMContentLoaded", init);
