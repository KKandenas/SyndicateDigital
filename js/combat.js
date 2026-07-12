// combat.js
// Ansvar: direkt konfrontation (slagsmål/arrestering) och razzior mot
// dolda svartklubbar. Innehåller reglerna för VEM man får angripa och VAR.

import { paths, dbGet, dbUpdate } from "./firebase.js";
import { isPortTile } from "./map.js";
import { pickRandomStreetTile } from "./map.js";
import { isPolice } from "./players.js";
import { consumeActionPoint } from "./game.js";
import { toast } from "./ui.js";

/** REGEL: inga slagsmål i hamnen — hamnen används bara för att hämta sprit. */
export function canFightHere(x, y) {
    return !isPortTile(x, y);
}

/**
 * REGEL: gäng-spelare får inte utmana polisen på duell.
 * Filtrerar bort ogiltiga mål ur en lista med spelare på samma ruta.
 */
export function getValidCombatTargets(meIsPolice, playersOnTile) {
    if (meIsPolice) return playersOnTile; // polisen får haffa vem som helst på rutan
    return playersOnTile.filter((p) => !isPolice(p));
}

export async function directFightOrArrest(roomCode, myPlayerId, tileX, tileY) {
    if (!canFightHere(tileX, tileY)) {
        toast("Ingen bråkar i hamnen — här handlar det bara om varor.", "warning");
        return;
    }

    const room = await dbGet(paths.room(roomCode));
    const me = room.players[myPlayerId];
    const players = room.players;
    const meIsPolice = isPolice(me);

    const targetsHere = Object.entries(players).filter(
        ([id, p]) => id !== myPlayerId && p.x === tileX && p.y === tileY
    );
    const validTargets = getValidCombatTargets(meIsPolice, targetsHere.map(([, p]) => p))
        .map((p) => targetsHere.find(([, tp]) => tp === p));

    if (validTargets.length === 0) {
        toast(meIsPolice ? "Ingen att haffa här." : "Ingen att slåss med här.", "info");
        return;
    }

    const updates = {};
    let stolenCashTotal = 0;
    let confiscatedBooze = 0;
    const reportLines = [];

    for (const [targetId, target] of validTargets) {
        if (meIsPolice) {
            if (target.booze > 0) {
                confiscatedBooze += target.booze;
                updates[`${paths.player(roomCode, targetId)}/booze`] = 0;
            }
            const fine = Math.floor(target.cash / 2);
            if (fine > 0) {
                stolenCashTotal += fine;
                updates[`${paths.player(roomCode, targetId)}/cash`] = target.cash - fine;
            }
            reportLines.push(`👮 Haffade ${target.name}! Beslag: ${target.booze} sprit, $${fine} i böter.`);
        } else {
            const stolen = Math.floor(target.cash / 2);
            if (stolen > 0) {
                stolenCashTotal += stolen;
                updates[`${paths.player(roomCode, targetId)}/cash`] = target.cash - stolen;
            }
            reportLines.push(`👊 Spöade ${target.name} och rånade $${stolen}!`);
        }
    }

    if (Object.keys(updates).length > 0) {
        await dbUpdate(updates);
    }

    toast(reportLines.join(" "), meIsPolice ? "police" : "gang");

    await consumeActionPoint(roomCode, myPlayerId, {
        cash: me.cash + stolenCashTotal,
        booze: me.booze + confiscatedBooze,
    });
}

export async function blindSearchTile(roomCode, myPlayerId, tileX, tileY) {
    const room = await dbGet(paths.room(roomCode));
    const me = room.players[myPlayerId];
    const players = room.players;
    const secrets = room.secrets || {};
    const meIsPolice = isPolice(me);

    const updates = {};
    let cashGain = 0;
    const reportLines = [];
    let foundAny = false;

    // Undvik att flytta en avslöjad klubb till en ruta som redan är upptagen
    // av en annan hemlig zon (samma regel som vid spelstart).
    const occupied = [];
    for (const pid in secrets) {
        if (secrets[pid].club) occupied.push(secrets[pid].club);
        if (secrets[pid].stash) occupied.push(secrets[pid].stash);
    }

    for (const targetId in secrets) {
        if (targetId === myPlayerId) continue;
        const targetSecret = secrets[targetId];
        if (targetSecret.club && targetSecret.club.x === tileX && targetSecret.club.y === tileY) {
            foundAny = true;
            const lostStock = targetSecret.club.stock || 0;
            const lostClubCash = targetSecret.club.clubCash || 0;
            cashGain += lostClubCash;

            const targetName = players[targetId] ? players[targetId].name : "okänd";
            reportLines.push(
                meIsPolice
                    ? `🚨 Razzia mot ${targetName}s klubb! Beslag $${lostClubCash}, hällde ut ${lostStock} flaskor.`
                    : `🪑 Stormade ${targetName}s klubb, stal $${lostClubCash} och förstörde ${lostStock} flaskor.`
            );

            const newClub = pickRandomStreetTile(occupied);
            updates[`${paths.secret(roomCode, targetId)}/club`] = {
                x: newClub.x, y: newClub.y, stock: 0, clubCash: 0,
            };
            occupied.push(newClub);
        }
    }

    if (!foundAny) {
        toast(meIsPolice ? "Razzian gav inget här." : "Tom gränd. Inga klubbar här.", "info");
        await consumeActionPoint(roomCode, myPlayerId, {});
        return;
    }

    if (Object.keys(updates).length > 0) {
        await dbUpdate(updates);
    }
    toast(reportLines.join(" "), meIsPolice ? "police" : "gang");

    await consumeActionPoint(roomCode, myPlayerId, { cash: me.cash + cashGain });
}
