// movement.js
// Ansvar: flytta spelaren på griden, med de spelregler som styr VAR man
// får gå. Ren spellogik + DB-anrop, ingen DOM här.

import { paths, dbGet } from "./firebase.js";
import { isPortTile, isPoliceTile } from "./map.js";
import { isPolice } from "./players.js";
import { consumeActionPoint } from "./game.js";
import { toast } from "./ui.js";

/**
 * REGLER:
 * - Polisen får inte gå till hamnen.
 * - Övriga spelare (gäng) får inte gå till polishuset.
 */
function isMoveAllowed(meIsPolice, targetX, targetY) {
    if (meIsPolice && isPortTile(targetX, targetY)) {
        return { allowed: false, reason: "Polisen har inget ärende i smuggelhamnen." };
    }
    if (!meIsPolice && isPoliceTile(targetX, targetY)) {
        return { allowed: false, reason: "Du vågar dig inte in på polisstationen." };
    }
    return { allowed: true };
}

export async function movePlayer(roomCode, myPlayerId, dx, dy) {
    const room = await dbGet(paths.room(roomCode));
    if (!room || room.currentTurn !== myPlayerId) return;

    const me = room.players[myPlayerId];
    if (!me) return;

    const nX = Math.max(0, Math.min(4, me.x + dx));
    const nY = Math.max(0, Math.min(4, me.y + dy));
    if (nX === me.x && nY === me.y) return;

    const check = isMoveAllowed(isPolice(me), nX, nY);
    if (!check.allowed) {
        toast(check.reason, "warning");
        return;
    }

    await consumeActionPoint(roomCode, myPlayerId, { x: nX, y: nY });
}
