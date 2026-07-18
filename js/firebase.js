// firebase.js
// Ansvar: EN plats för Firebase-init + generiska, transaction-säkra DB-helpers.
// Ingen spellogik hör hemma här — bara läsning/skrivning mot databasen.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    getDatabase, ref, set, get, update, onValue, off,
    runTransaction, onDisconnect
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyBJMAUFQYCpvbXl3T1fyEb1dZRFqXbPFQ8",
    authDomain: "noir-syndicate-digital.firebaseapp.com",
    databaseURL: "https://noir-syndicate-digital-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "noir-syndicate-digital",
    storageBucket: "noir-syndicate-digital.firebasestorage.app",
    messagingSenderId: "211341530009",
    appId: "1:211341530009:web:31366f14989e8f4b737908"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);

// --- Sökvägshjälpare (håller strängarna på ett ställe) ---
export const paths = {
    room: (code) => `rooms/${code}`,
    players: (code) => `rooms/${code}/players`,
    player: (code, playerId) => `rooms/${code}/players/${playerId}`,
    secrets: (code) => `rooms/${code}/secrets`,
    secret: (code, playerId) => `rooms/${code}/secrets/${playerId}`,
    currentTurn: (code) => `rooms/${code}/currentTurn`,
    status: (code) => `rooms/${code}/status`,
    policeBusts: (code) => `rooms/${code}/policeBusts`,
    winner: (code) => `rooms/${code}/winner`,
};

// --- Generiska wrappers ---
export function dbRef(path) { return ref(db, path); }

export async function dbSet(path, value) { return set(ref(db, path), value); }

export async function dbGet(path) {
    const snap = await get(ref(db, path));
    return snap.exists() ? snap.val() : null;
}

export async function dbUpdate(updatesObj) { return update(ref(db), updatesObj); }
export async function dbUpdateAt(path, value) { return update(ref(db, path), value); }

export function dbListen(path, callback) {
    const r = ref(db, path);
    onValue(r, (snap) => callback(snap.exists() ? snap.val() : null));
    return () => off(r);
}

// Transaction-säker uppdatering av en enskild spelare.
// Löser race conditions: två snabba klick / dålig uppkoppling kan inte
// längre ge dubbla AP-avdrag eller felräknade pengar, eftersom Firebase
// kör om transaktionen om datan hunnit ändras under tiden.
export async function dbTransactPlayer(roomCode, playerId, updateFn) {
    const playerRef = ref(db, paths.player(roomCode, playerId));
    const result = await runTransaction(playerRef, (current) => {
        if (current === null) return current; // spelaren finns inte längre, avbryt
        return updateFn(current);
    });
    return result.snapshot.val();
}

export async function dbTransactSecret(roomCode, playerId, updateFn) {
    const secretRef = ref(db, paths.secret(roomCode, playerId));
    const result = await runTransaction(secretRef, (current) => {
        if (current === null) return current;
        return updateFn(current);
    });
    return result.snapshot.val();
}

// Räknar upp ett värde på en given sökväg, transaktionssäkert (t.ex. antal
// lyckade razzior polisen genomfört totalt).
export async function dbIncrementCounter(path, delta = 1) {
    const counterRef = ref(db, path);
    const result = await runTransaction(counterRef, (current) => (current || 0) + delta);
    return result.snapshot.val();
}

// Sätter ett värde EN gång — om något redan står där lämnas det orört.
// Används för att avgöra vinnaren utan att flera klienter som upptäcker
// samma vinstvillkor samtidigt skriver över varandra.
export async function dbClaimOnce(path, value) {
    const claimRef = ref(db, path);
    const result = await runTransaction(claimRef, (current) => (current !== null ? current : value));
    return result.snapshot.val();
}

export { onDisconnect, ref };
