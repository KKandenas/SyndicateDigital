// movement.js
// Ansvar: flytta spelaren på griden, med de spelregler som styr VAR man
// får gå — samt automatisk leverans/upphämtning vid klubb, gömma och
// polisstation. Detta hanteras HÄR (inte passivt vid varje omritning)
// så att AP-avdrag, positionsändring och leverans/insättning alltid sker
// som EN sammanhängande händelse och aldrig kan hamna i otakt med varandra.

import { paths, dbGet, dbUpdate } from "./firebase.js";
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

    const meIsPolice = isPolice(me);
    const check = isMoveAllowed(meIsPolice, nX, nY);
    if (!check.allowed) {
        toast(check.reason, "warning");
        return;
    }

    // TILLFÄLLIG DIAGNOS — visar exakt vad koden jämför. Tas bort igen
    // så fort vi hittat orsaken till leverans-buggen.
    if (!meIsPolice && room.secrets && room.secrets[myPlayerId]) {
        const s = room.secrets[myPlayerId];
        toast(
            `DEBUG: ankom (${nX},${nY}) | klubb=(${s.club ? s.club.x : "?"},${s.club ? s.club.y : "?"}) | ` +
            `gömma=(${s.stash ? s.stash.x : "?"},${s.stash ? s.stash.y : "?"}) | booze=${me.booze}`,
            "info",
            6000
        );
    } else {
        toast(`DEBUG: ankom (${nX},${nY}) | meIsPolice=${meIsPolice} | secrets finns=${!!room.secrets} | egen secret finns=${!!(room.secrets && room.secrets[myPlayerId])}`, "info", 6000);
    }

    // Samla ALLA fältändringar för denna enda förflyttning i ett objekt.
    // Allt nedan skrivs sedan tillsammans med AP-avdraget i EN transaktion.
    const fieldUpdates = { x: nX, y: nY };
    const secretUpdates = {};
    const messages = [];

    if (!meIsPolice && room.secrets && room.secrets[myPlayerId]) {
        const mySecret = room.secrets[myPlayerId];

        if (mySecret.club && nX === mySecret.club.x && nY === mySecret.club.y) {
            if (me.booze > 0) {
                const currentStock = mySecret.club.stock || 0;
                secretUpdates[`${paths.secret(roomCode, myPlayerId)}/club/stock`] = currentStock + me.booze;
                fieldUpdates.booze = 0;
                messages.push(`🍸 Levererade ${me.booze} flaskor till klubbens lager!`);
            }
            if (mySecret.club.clubCash > 0) {
                fieldUpdates.cash = (fieldUpdates.cash ?? me.cash) + mySecret.club.clubCash;
                secretUpdates[`${paths.secret(roomCode, myPlayerId)}/club/clubCash`] = 0;
                messages.push(`💰 Hämtade $${mySecret.club.clubCash} från klubbkassan!`);
            }
        }

        if (mySecret.stash && nX === mySecret.stash.x && nY === mySecret.stash.y && me.cash > 0) {
            const cashToSecure = fieldUpdates.cash ?? me.cash;
            fieldUpdates.cash = 0;
            fieldUpdates.bank = me.bank + cashToSecure;
            messages.push(`🏦 Tryggade $${cashToSecure} i gömman.`);
        }
    } else if (meIsPolice && nX === 2 && nY === 2 && me.cash > 0) {
        fieldUpdates.cash = 0;
        fieldUpdates.bank = me.bank + me.cash;
        messages.push(`🏦 Redovisade $${me.cash} till statskassan.`);
    }

    // Klubb/gömma ligger i en separat "secrets"-nod och kan inte ingå i
    // samma transaktion som spelarnoden, men vi skriver den HÄR, direkt
    // efter varandra i samma funktionsanrop — inte i en senare, separat
    // renderingscykel — så det upplevs som en och samma händelse.
    if (Object.keys(secretUpdates).length > 0) {
        await dbUpdate(secretUpdates);
    }
    if (messages.length > 0) {
        toast(messages.join(" "), meIsPolice ? "police" : "success");
    }

    // AP-avdrag + position (+ ev. cash/booze/bank-ändringar ovan) skrivs
    // ALLTID tillsammans, i en enda spelar-transaktion.
    await consumeActionPoint(roomCode, myPlayerId, fieldUpdates);
}
