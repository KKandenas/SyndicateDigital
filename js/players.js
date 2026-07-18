// players.js
// Ansvar: allt som rör att skapa rum, gå med i rum, och tilldela
// syndikat/polis-roll när spelet startar. Inga UI-DOM-anrop här.

import { dbSet, dbGet, dbUpdate, paths, registerPresence } from "./firebase.js";
import { generateSecretsForPlayers } from "./map.js";

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

    const playerId = makePlayerId();
    await dbSet(paths.player(code, playerId), newPlayerRecord(playerName.trim(), false));
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
