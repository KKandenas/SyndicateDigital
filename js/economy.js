// economy.js
// Ansvar: allt som rör pengar och sprit — köp, försäljning, insättning.

import { paths, dbGet, dbUpdate } from "./firebase.js";
import { isPolice } from "./players.js";
import { consumeActionPoint } from "./game.js";
import { toast } from "./ui.js";

const MAX_BOOZE = 3;
const CLUB_SALE_PROFIT = 500;

export async function getBoozeFromPort(roomCode, myPlayerId) {
    const me = await dbGet(paths.player(roomCode, myPlayerId));
    if (!me) return;
    if (me.booze >= MAX_BOOZE) {
        toast("Korgen är full!", "warning");
        return;
    }
    await consumeActionPoint(roomCode, myPlayerId, { booze: me.booze + 1 });
}

/**
 * Körs en gång per spelares turstart (styrs från game.js).
 * Säljer 1 enhet lagerförd sprit ur klubben: pengarna går direkt i fickan
 * om spelaren råkar stå på klubben, annars parkeras de i klubbkassan.
 */
export async function handleTurnStartIncome(roomCode, myPlayerId, roomData) {
    const me = roomData.players[myPlayerId];
    if (isPolice(me)) return;
    const mySecret = roomData.secrets && roomData.secrets[myPlayerId];
    if (!mySecret || !mySecret.club) return;

    const stock = mySecret.club.stock || 0;
    if (stock <= 0) return;

    const updates = {};
    const atClub = me.x === mySecret.club.x && me.y === mySecret.club.y;

    if (atClub) {
        updates[`${paths.player(roomCode, myPlayerId)}/cash`] = me.cash + CLUB_SALE_PROFIT;
        toast(`🍸 Klubben sålde 1 sprit. $${CLUB_SALE_PROFIT} rakt i fickan!`, "success");
    } else {
        const clubCash = mySecret.club.clubCash || 0;
        updates[`${paths.secret(roomCode, myPlayerId)}/club/clubCash`] = clubCash + CLUB_SALE_PROFIT;
        toast(`🍸 Klubben sålde 1 sprit. $${CLUB_SALE_PROFIT} lades i klubbkassan.`, "success");
    }
    updates[`${paths.secret(roomCode, myPlayerId)}/club/stock`] = stock - 1;

    await dbUpdate(updates);
}

// OBS: automatisk leverans/upphämtning vid klubb, gömma och polisstation
// hanteras numera direkt i movement.js — som en del av samma transaktion
// som förflyttningen. Det garanterar att AP-avdrag, positionsändring och
// leverans/insättning alltid sker som EN sammanhängande händelse, istället
// för två separata skrivningar som kunde hamna i otakt med varandra.
