// economy.js
// Ansvar: allt som rör pengar och sprit — köp, försäljning, insättning.

import { dbTransactPlayer, dbTransactSecret } from "./firebase.js";
import { isPolice } from "./players.js";
import { consumeActionPoint } from "./game.js";
import { toast } from "./ui.js";

const MAX_BOOZE = 3;
const CLUB_SALE_PROFIT = 500;

export async function getBoozeFromPort(roomCode, myPlayerId) {
    // Kontroll och ökning i SAMMA transaktion mot den FÄRSKA spelar-noden:
    // annars kunde ett snabbt dubbeltryck (innan knappen hinner inaktiveras)
    // dra AP två gånger men bara kreditera 1 sprit, eller runda maxgränsen.
    let full = false;
    await dbTransactPlayer(roomCode, myPlayerId, (current) => {
        if (!current) return current;
        if ((current.booze || 0) >= MAX_BOOZE) {
            full = true;
            return current;
        }
        return { ...current, booze: (current.booze || 0) + 1 };
    });

    if (full) {
        toast("Korgen är full!", "warning");
        return;
    }
    await consumeActionPoint(roomCode, myPlayerId, {});
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
    if ((mySecret.club.stock || 0) <= 0) return;

    const atClub = me.x === mySecret.club.x && me.y === mySecret.club.y;

    // Lagret dras och ev. klubbkassa fylls på i en transaktion mot klubbens
    // FÄRSKA nod-data (inte roomData ovan) — annars kunde en leverans som
    // just skett i movement.js bli överskriven av denna, stale-beräknade
    // uppdatering.
    let stockSold = 0;
    await dbTransactSecret(roomCode, myPlayerId, (current) => {
        if (!current || !current.club) return current;
        const stock = current.club.stock || 0;
        if (stock <= 0) return current;
        stockSold = 1;
        return {
            ...current,
            club: {
                ...current.club,
                stock: stock - 1,
                clubCash: atClub
                    ? (current.club.clubCash || 0)
                    : (current.club.clubCash || 0) + CLUB_SALE_PROFIT,
            },
        };
    });
    if (stockSold === 0) return;

    if (atClub) {
        // Samma resonemang för spelarens ficka: lägg till som en delta ur
        // färsk data, inte som ett belopp uträknat från `me` ovan.
        await dbTransactPlayer(roomCode, myPlayerId, (current) => ({
            ...current,
            cash: (current.cash || 0) + CLUB_SALE_PROFIT,
        }));
        toast(`🍸 Klubben sålde 1 sprit. $${CLUB_SALE_PROFIT} rakt i fickan!`, "success");
    } else {
        toast(`🍸 Klubben sålde 1 sprit. $${CLUB_SALE_PROFIT} lades i klubbkassan.`, "success");
    }
}

// OBS: automatisk leverans/upphämtning vid klubb, gömma och polisstation
// hanteras numera direkt i movement.js — som en del av samma transaktion
// som förflyttningen. Det garanterar att AP-avdrag, positionsändring och
// leverans/insättning alltid sker som EN sammanhängande händelse, istället
// för två separata skrivningar som kunde hamna i otakt med varandra.
