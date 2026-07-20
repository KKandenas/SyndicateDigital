// players.js
// Ansvar: allt som rör att skapa rum, gå med i rum, och tilldela
// syndikat/polis-roll när spelet startar. Inga UI-DOM-anrop här.

import { dbSet, dbGet, dbUpdate, paths, registerPresence } from "./firebase.js";
import { generateSecretsForPlayers, pickRandomOpenTile } from "./map.js";

export const ROLE = {
    POLICE: "police",
    GANG: "gang",
};

const GANG_POOL = [
    { name: "♠ Nightspades", x: 0, y: 0 },
    { name: "♥ Crimson Hearts", x: 4, y: 0 },
    { name: "♣ Iron Clovers", x: 0, y: 4 },
    { name: "♦ Diamond Syndicate", x: 4, y: 4 },
];

// 1 polis + ett syndikat per plats i GANG_POOL — fler än så finns det varken
// startpositioner eller syndikatnamn för.
export const MAX_PLAYERS = GANG_POOL.length + 1;

const POLICE_START = { x: 2, y: 2 };
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomCode() {
    let code = "";
    for (let i = 0; i < 4; i++) {
        code += ROOM_CODE_CHARS.charAt(Math.floor(Math.random() * ROOM_CODE_CHARS.length));
    }
    return code;
}

function makePlayerId() {
    return "player_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
}

function newPlayerRecord(name, isLeader) {
    return {
        name,
        syndicate: "Pending",
        role: null,
        x: 0, y: 0,
        booze: 0, cash: 0, bank: 0,
        ap: 3,
        isLeader,
        connected: true,
    };
}

/** REGEL: den som skapar spelet anger sitt eget namn (fanns inte tidigare). */
export async function createRoom(hostName) {
    const code = generateRoomCode();
    const playerId = makePlayerId();

    await dbSet(paths.room(code), {
        status: "lobby",
        currentTurn: playerId,
        createdAt: Date.now(),
    });
    await dbSet(paths.player(code, playerId), newPlayerRecord(hostName.trim() || "Boss", true));
    registerPresence(code, playerId);

    return { roomCode: code, playerId, isLeader: true };
}

export async function joinRoom(roomCode, playerName) {
    const code = roomCode.toUpperCase().trim();
    const room = await dbGet(paths.room(code));
    if (!room) throw new Error("Rummet finns inte!");
    if (room.winner) throw new Error("Spelet är redan slut — be någon skapa ett nytt rum.");

    const connectedCount = Object.values(room.players || {}).filter((p) => p.connected !== false).length;
    if (connectedCount >= MAX_PLAYERS) {
        throw new Error(`Rummet är fullt (max ${MAX_PLAYERS} spelare).`);
    }

    const playerId = makePlayerId();
    const record = newPlayerRecord(playerName.trim(), false);
    const updates = { [paths.player(code, playerId)]: record };

    if (room.status === "playing") {
        // Spelet har redan börjat — en sen spelare måste få en riktig roll
        // direkt (syndikat, startposition, hemlig klubb/gömma), annars blir
        // de en spökspelare utan roll som aldrig kan agera eller ha en tur.
        const takenSyndicates = new Set(Object.values(room.players || {}).map((p) => p.syndicate));
        const gang = GANG_POOL.find((g) => !takenSyndicates.has(g.name));
        if (!gang) throw new Error("Alla gäng-platser är redan upptagna.");

        record.syndicate = gang.name;
        record.role = ROLE.GANG;
        record.x = gang.x;
        record.y = gang.y;

        // Ny hemlig klubb/gömma, kollisionsfri mot ALLA redan utdelade
        // hemligheter — samma princip som razzia-omflytt i combat.js.
        const existingSecrets = room.secrets || {};
        const occupied = [];
        for (const pid in existingSecrets) {
            if (existingSecrets[pid].club) occupied.push(existingSecrets[pid].club);
            if (existingSecrets[pid].stash) occupied.push(existingSecrets[pid].stash);
        }
        const club = pickRandomOpenTile(occupied);
        occupied.push(club);
        const stash = pickRandomOpenTile(occupied);

        updates[paths.secret(code, playerId)] = {
            club: { x: club.x, y: club.y, stock: 0, clubCash: 0 },
            stash: { x: stash.x, y: stash.y },
        };
    }

    await dbUpdate(updates);
    registerPresence(code, playerId);

    return { roomCode: code, playerId, isLeader: false };
}

/**
 * Tilldelar en slumpad spelare polisrollen och resten ett syndikat,
 * samt genererar klubbar/gömmor kollisionsfritt för alla icke-poliser.
 * Endast rumsledaren (isLeader) ska anropa denna.
 */
export async function assignRolesAndStart(roomCode) {
    const players = await dbGet(paths.players(roomCode));
    if (!players) throw new Error("Inga spelare hittades.");

    // Bara spelare som fortfarande är kvar i lobbyn ska få en roll — annars
    // slösas en gäng-plats bort på en "spökspelare" som redan lämnat innan
    // spelet ens började.
    const playerIds = Object.keys(players).filter((id) => players[id].connected !== false);
    if (playerIds.length === 0) throw new Error("Alla spelare har lämnat rummet.");

    const policeId = playerIds[Math.floor(Math.random() * playerIds.length)];
    const gangPool = [...GANG_POOL];

    const updates = {};
    const nonPoliceIds = [];

    playerIds.forEach((id) => {
        if (id === policeId) {
            updates[`${paths.player(roomCode, id)}/syndicate`] = "🚨 Kalmar Poliskår";
            updates[`${paths.player(roomCode, id)}/role`] = ROLE.POLICE;
            updates[`${paths.player(roomCode, id)}/x`] = POLICE_START.x;
            updates[`${paths.player(roomCode, id)}/y`] = POLICE_START.y;
        } else {
            const gang = gangPool.shift() || { name: "Independent", x: 0, y: 0 };
            updates[`${paths.player(roomCode, id)}/syndicate`] = gang.name;
            updates[`${paths.player(roomCode, id)}/role`] = ROLE.GANG;
            updates[`${paths.player(roomCode, id)}/x`] = gang.x;
            updates[`${paths.player(roomCode, id)}/y`] = gang.y;
            nonPoliceIds.push(id);
        }
    });

    const secretsData = generateSecretsForPlayers(nonPoliceIds);

    updates[paths.status(roomCode)] = "playing";
    updates[paths.secrets(roomCode)] = secretsData;

    await dbUpdate(updates);
}

export function isPolice(playerRecord) {
    // role-fältet är sanningen; syndicate-strängen är bara visningstext.
    return !!playerRecord && playerRecord.role === ROLE.POLICE;
}
