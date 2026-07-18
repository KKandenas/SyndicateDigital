// map.js
// Ansvar: statisk kartdata + all logik som rör rutor: typ-uppslag,
// slumpmässig men REGELSÄKER placering av klubbar/gömmor.

export const TILE = {
    HQ_BLACK: "hq-black",
    HQ_RED: "hq-red",
    STREET_BLACK: "street-black",
    STREET_RED: "street-red",
    PORT: "port",
    POLICE: "police",
};

export const PORT_COORD = { x: 2, y: 0 };
export const POLICE_COORD = { x: 2, y: 2 };

export const cityMapData = [
    { x: 0, y: 0, type: TILE.HQ_BLACK, name: "Obsidian" },
    { x: 1, y: 0, type: TILE.STREET_BLACK, name: "Shadow" },
    { x: 2, y: 0, type: TILE.PORT, name: "Port ⚓" },
    { x: 3, y: 0, type: TILE.STREET_RED, name: "Neon" },
    { x: 4, y: 0, type: TILE.HQ_RED, name: "Crimson" },

    { x: 0, y: 1, type: TILE.STREET_BLACK, name: "Charcoal" },
    { x: 1, y: 1, type: TILE.STREET_BLACK, name: "Noir SH" },
    { x: 2, y: 1, type: TILE.STREET_BLACK, name: "Foggy" },
    { x: 3, y: 1, type: TILE.STREET_RED, name: "Ruby Bk" },
    { x: 4, y: 1, type: TILE.STREET_RED, name: "Scarlet" },

    { x: 0, y: 2, type: TILE.STREET_BLACK, name: "Smuggl" },
    { x: 1, y: 2, type: TILE.STREET_BLACK, name: "Blind" },
    { x: 2, y: 2, type: TILE.POLICE, name: "POLIS 🚨" },
    { x: 3, y: 2, type: TILE.STREET_RED, name: "Viper" },
    { x: 4, y: 2, type: TILE.STREET_RED, name: "Blood St" },

    { x: 0, y: 3, type: TILE.STREET_BLACK, name: "Dusk" },
    { x: 1, y: 3, type: TILE.STREET_BLACK, name: "Rust" },
    { x: 2, y: 3, type: TILE.STREET_RED, name: "Velvet" },
    { x: 3, y: 3, type: TILE.STREET_RED, name: "Roulette" },
    { x: 4, y: 3, type: TILE.STREET_RED, name: "Red Light" },

    { x: 0, y: 4, type: TILE.HQ_BLACK, name: "Onyx" },
    { x: 1, y: 4, type: TILE.STREET_BLACK, name: "Iron Grid" },
    { x: 2, y: 4, type: TILE.STREET_RED, name: "Marble" },
    { x: 3, y: 4, type: TILE.STREET_RED, name: "Dice" },
    { x: 4, y: 4, type: TILE.HQ_RED, name: "Casino" },
];

export function tileAt(x, y) {
    return cityMapData.find((t) => t.x === x && t.y === y) || null;
}

// "Öppen" ruta = allt utom Hamnen och Polishuset, som har egna särregler.
// Hörnen (start-HQ) räknas hit precis som vanliga gator: de är bara
// startpositioner, inte funktionellt speciella.
export function isOpenTile(tile) {
    return !!tile && tile.type !== TILE.PORT && tile.type !== TILE.POLICE;
}

export function isPortTile(x, y) {
    return x === PORT_COORD.x && y === PORT_COORD.y;
}

export function isPoliceTile(x, y) {
    return x === POLICE_COORD.x && y === POLICE_COORD.y;
}

// REGEL: Svartklubbar och gömmor får aldrig ligga på hamnen eller polishuset
// (se isOpenTile), och aldrig dela ruta med en annan hemlig zon (varken
// egen eller annan spelares) — det senare garanteras av att varje ruta
// bara delas ut en gång ur poolen nedan.
const validOpenTiles = cityMapData.filter(isOpenTile);

/**
 * Slumpar fram klubb- och gömma-koordinater för ALLA icke-polis-spelare
 * på en gång, så att ingen ruta återanvänds mellan spelare eller mellan
 * en spelares egen klubb/gömma. Detta löser buggen där olika spelares
 * hemligheter kunde krocka på samma ruta.
 */
export function generateSecretsForPlayers(nonPolicePlayerIds) {
    const pool = [...validOpenTiles];
    shuffle(pool);

    if (pool.length < nonPolicePlayerIds.length * 2) {
        // Skulle bara kunna hända om kartan görs mycket mindre — skydda ändå.
        throw new Error("Inte tillräckligt med giltiga rutor för klubbar/gömmor.");
    }

    const secrets = {};
    let cursor = 0;
    for (const playerId of nonPolicePlayerIds) {
        const club = pool[cursor++];
        const stash = pool[cursor++];
        secrets[playerId] = {
            club: { x: club.x, y: club.y, stock: 0, clubCash: 0 },
            stash: { x: stash.x, y: stash.y },
        };
    }
    return secrets;
}

/** Slumpar EN ny giltig ruta, exkluderar valfria upptagna rutor (t.ex. vid razzia-omflytt). */
export function pickRandomOpenTile(excludeCoords = []) {
    const candidates = validOpenTiles.filter(
        (t) => !excludeCoords.some((c) => c.x === t.x && c.y === t.y)
    );
    const pool = candidates.length > 0 ? candidates : validOpenTiles;
    return pool[Math.floor(Math.random() * pool.length)];
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}
