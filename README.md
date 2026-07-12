# Noir Syndicate — Underworld Engine (v2)

Webbaserat multiplayer-spel byggt i vanilla HTML/CSS/JavaScript (ES-moduler)
med Firebase Realtime Database som backend. Inga byggverktyg krävs.

## Köra spelet

Spelet **måste** köras via en webbserver (http:// eller https://) — inte
öppnas direkt som fil (file://), eftersom ES-moduler (import/export)
blockeras av webbläsaren annars.

### Snabbast: GitHub Pages
1. Ladda upp hela mappen till ett GitHub-repo (se tidigare instruktion).
2. Gå till repots Settings → Pages.
3. Under "Build and deployment" → Source: välj "Deploy from a branch",
   branch main, mapp /(root).
4. Spara. Efter någon minut är spelet live på
   https://dittanvändarnamn.github.io/dittrepo/

### Lokalt under utveckling
Valfri enkel statisk server, t.ex.:

    npx serve .

eller Pythons inbyggda server:

    python3 -m http.server 8080

Öppna sedan http://localhost:8080 (eller den port servern anger).

## Filstruktur

    index.html          Markup, inga inline-script eller onclick-attribut
    style.css           All styling
    js/
      firebase.js       Firebase-init + generiska, transaktionssäkra DB-helpers
      map.js            Kartdata, tile-typer, kollisionsfri placering av hemligheter
      players.js        Skapa/gå med i rum, rolltilldelning vid spelstart
      movement.js       Rörelse + regler för var man får gå
      combat.js         Slagsmål/arrestering + razzior mot svartklubbar
      economy.js        Sprit, klubbinkomst, gömma, polisens statskassa
      ui.js             All DOM-rendering + toast-meddelanden
      game.js           State, tur-/AP-motor, huvudlyssnare, DOM-inbindning

Se kommentarer i respektive fil för var i koden en specifik spelregel
implementeras (sök på "REGEL:").

## Spelregler i korthet

- 5×5 karta. En spelare blir slumpmässigt polis, resten fördelas på
  fyra syndikat (♠ ♥ ♣ ♦).
- Varje tur ger 3 AP. Rörelse, slagsmål, razzia och att hämta sprit kostar
  1 AP vardera. Vid 0 AP går turen automatiskt vidare.
- Hamnen: enda platsen att hämta sprit (max 3 åt gången). Inga
  slagsmål tillåtna här. Polisen får inte gå hit.
- Polishuset: gäng-spelare får inte gå hit. Polisen redovisar sina
  böter/beslag till statskassan här.
- Svartklubbar (dolda, en per gäng-spelare): leverera sprit hit för
  lager. Varje egen tur säljs 1 enhet automatiskt för $500. Ligger aldrig
  på hamnen, polishuset, eller samma ruta som en annan hemlig zon.
- Gömmor (dolda, en per gäng-spelare): säkrar cash till bank,
  oåtkomligt för andra spelare.
- Slagsmål: gäng mot gäng, eller polis mot gäng (arrestering). Gäng
  kan inte utmana polis på duell.
- Razzia/sök lönnkrog: chansa på gaturutor för att hitta och plundra
  en annan spelares dolda klubb — den flyttas därefter till en ny,
  kollisionsfri ruta.

## Kända begränsningar (medvetet inte åtgärdade ännu)

- Firebase Security Rules är inte konfigurerade. secrets-noden är i
  praktiken läsbar av alla klienter i rummet (döljs bara i UI:t) — en
  teknisk spelare kan läsa andras klubb/gömma-koordinater via
  webbläsarens nätverksflik. Bör låsas ner per spelare innan spelet
  används av folk du inte litar på.
- Spelare som lämnar mitt i spelet hanteras inte. Om det är den
  spelarens tur låser sig spelet tills de kommer tillbaka.

## Nästa steg

Se separat regeltest-checklista (Steg 4) för att verifiera samtliga
spelregler efter varje kodändring.
