// combat.js
// Ansvar: direkt konfrontation (slagsmål/arrestering) och razzior mot
// dolda svartklubbar. Innehåller reglerna för VEM man får angripa och VAR.

import { paths, dbGet, dbTransactPlayer, dbTransactSecret, dbIncrementCounter } from "./firebase.js";
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

    // Varje måls cash/booze uppdateras i en EGEN spelar-transaktion, härledd
    // ur den FÄRSKA nod-datan vid skrivtillfället — inte ur ett belopp som
    // räknats ut i förväg från ögonblicksbilden ovan. Det förhindrar att två
    // nästan samtidiga angrepp mot samma mål skriver över varandra och
    // duplicerar (eller raderar) pengar/sprit.
    const results = await Promise.all(validTargets.map(async ([targetId, target]) => {
        let fine = 0;
        let seizedBooze = 0;
        let stolen = 0;

        await dbTransactPlayer(roomCode, targetId, (current) => {
            if (meIsPolice) {
                seizedBooze = current.booze || 0;
                fine = Math.floor((current.cash || 0) / 2);
                return { ...current, cash: current.cash - fine, booze: 0 };
            }
            stolen = Math.floor((current.cash || 0) / 2);
            return { ...current, cash: current.cash - stolen };
        });

        return meIsPolice
            ? { name: target.name, fine, seizedBooze }
            : { name: target.name, stolen };
    }));

    let stolenCashTotal = 0;
    let confiscatedBooze = 0;
    const reportLines = [];

    for (const r of results) {
        if (meIsPolice) {
            stolenCashTotal += r.fine;
            confiscatedBooze += r.seizedBooze;
            reportLines.push(`👮 Haffade ${r.name}! Beslag: ${r.seizedBooze} sprit, $${r.fine} i böter (i fickan — redovisa på stationen).`);
        } else {
            stolenCashTotal += r.stolen;
            reportLines.push(`👊 Spöade ${r.name} och rånade $${r.stolen}!`);
        }
    }

    toast(reportLines.join(" "), meIsPolice ? "police" : "gang");

    // Egen vinst (byte/beslag) läggs till som en delta på den FÄRSKA
    // spelar-noden, inte som ett belopp uträknat från `me` ovan — annars
    // kunde t.ex. ett dubbeltryck på knappen tappa bort den ena vinsten.
    if (stolenCashTotal > 0 || confiscatedBooze > 0) {
        await dbTransactPlayer(roomCode, myPlayerId, (current) => ({
            ...current,
            cash: (current.cash || 0) + stolenCashTotal,
            booze: (current.booze || 0) + confiscatedBooze,
        }));
    }

    await consumeActionPoint(roomCode, myPlayerId, {});
}

export async function blindSearchTile(roomCode, myPlayerId, tileX, tileY) {
    const room = await dbGet(paths.room(roomCode));
    const me = room.players[myPlayerId];
    const players = room.players;
    const secrets = room.secrets || {};
    const meIsPolice = isPolice(me);

    // REGEL (map.js): klubbar/gömmor delar aldrig ruta, så högst en klubb
    // kan matcha den sökta rutan.
    const targetId = Object.keys(secrets).find(
        (id) => id !== myPlayerId && secrets[id].club &&
            secrets[id].club.x === tileX && secrets[id].club.y === tileY
    );

    if (!targetId) {
        toast(meIsPolice ? "Razzian gav inget här." : "Tom gränd. Inga klubbar här.", "info");
        await consumeActionPoint(roomCode, myPlayerId, {});
        return;
    }

    // Kollisionsfri-lista för den nya klubbplatsen (samma princip som vid
    // spelstart i map.js).
    const occupied = [];
    for (const pid in secrets) {
        if (secrets[pid].club) occupied.push(secrets[pid].club);
        if (secrets[pid].stash) occupied.push(secrets[pid].stash);
    }

    let lostStock = 0;
    let lostClubCash = 0;
    let alreadyGone = false;

    // Transaktionssäkert mot klubbens FÄRSKA nod-data: om två spelare råkar
    // hitta och plundra samma klubb i exakt samma ögonblick ska bara den
    // första få loot och flytta klubben — den andra möter en redan tömd/
    // förflyttad klubb istället för att skriva över den första vinnarens
    // beslag med sin egen, stale-beräknade "tömning".
    await dbTransactSecret(roomCode, targetId, (current) => {
        if (!current || !current.club || current.club.x !== tileX || current.club.y !== tileY) {
            alreadyGone = true;
            return current;
        }
        lostStock = current.club.stock || 0;
        lostClubCash = current.club.clubCash || 0;
        const newClub = pickRandomStreetTile(occupied);
        return { ...current, club: { x: newClub.x, y: newClub.y, stock: 0, clubCash: 0 } };
    });

    if (alreadyGone) {
        toast(meIsPolice ? "Razzian gav inget här." : "Tom gränd. Inga klubbar här.", "info");
        await consumeActionPoint(roomCode, myPlayerId, {});
        return;
    }

    const targetName = players[targetId] ? players[targetId].name : "okänd";
    toast(
        meIsPolice
            ? `🚨 Razzia mot ${targetName}s klubb! Beslag $${lostClubCash}, hällde ut ${lostStock} flaskor.`
            : `🪑 Stormade ${targetName}s klubb, stal $${lostClubCash} och förstörde ${lostStock} flaskor.`,
        meIsPolice ? "police" : "gang"
    );

    // Räknas mot polisens alternativa vinstvillkor (rules.js) — en fast
    // totalsumma lyckade razzior, inte "en per aktivt gäng".
    if (meIsPolice) {
        await dbIncrementCounter(paths.policeBusts(roomCode), 1);
    }

    if (lostClubCash > 0) {
        await dbTransactPlayer(roomCode, myPlayerId, (current) => ({
            ...current,
            cash: (current.cash || 0) + lostClubCash,
        }));
    }

    await consumeActionPoint(roomCode, myPlayerId, {});
}
