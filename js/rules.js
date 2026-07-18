// rules.js
// Ansvar: delade konstanter för vinstvillkoren, så att vinstdetektering
// (game.js) och HUD:ens förloppsstaplar (ui.js) alltid är i synk.

export const GANG_WIN_CASH = 3000;
export const POLICE_WIN_CASH = 2000;

// Fast antal, oavsett hur många gäng som faktiskt spelar — annars blir
// målet trivialt (bara 1 klubb att hitta) i en duell med ett enda gäng.
// Samma klubb räknas flera gånger om den hittas igen efter att ha flyttat.
export const POLICE_WIN_BUSTS = 4;
