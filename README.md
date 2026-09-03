# Fantasy Draft Board

Ein eigenes Draft-Board für Fantasy Football nach den Positionen und
Roster-Regeln einer ESPN-Liga — mit eigener Rangfolge statt der ESPN-ADP und
mit automatischem Abgleich, welche Spieler im laufenden Draft schon weg sind.

Die Seite ist statisch. Sie läuft auf GitHub Pages, auf dem iPhone, auf dem Mac
und lässt sich per Link teilen. Alle Daten werden im Browser des jeweiligen
Nutzers geholt und verarbeitet — es gibt keinen Server, keine Datenbank und
keine Konten.

---

## Was das Board bewertet

Grundlage ist nicht die rohe Punkteprognose, sondern der **Mehrwert gegenüber
einem frei verfügbaren Spieler derselben Position** (Value over Replacement).
Erst dadurch sind QB, RB, WR, TE, K und D/ST überhaupt vergleichbar: Ein QB mit
340 Projektionspunkten ist wenig wert, wenn der 13. QB noch 300 bringt.

Das Replacement-Level ergibt sich aus der echten Liga: Teamzahl und
Startaufstellung kommen aus `mSettings`, der FLEX-Platz wird anteilig auf
RB/WR/TE umgelegt.

Auf diese Basis wirken drei Faktoren:

| Faktor | Woher | Wirkung |
| --- | --- | --- |
| **Offense-Stärke** | Summe der projizierten Punkte der realistischen Fantasy-Starter des NFL-Teams (QB1, RB1–2, WR1–3, TE1), z-standardisiert über alle 32 Teams | Spieler in produktiven Offenses steigen |
| **Strength of Schedule** | Für jede Woche der Saison: wie viele Fantasy-Punkte lässt der Gegner an genau dieser Position zu (`mPositionalRatings`), verglichen mit dem Ligaschnitt. Die Fantasy-Playoff-Wochen zählen mehrfach | Spieler mit vielen schwachen Gegnern steigen |
| **Gesundheit** | `injuryStatus` aus der ESPN-API (ACTIVE, QUESTIONABLE, DOUBTFUL, OUT, IR, SUSPENSION, PUP …) | Angeschlagene Spieler fallen; „Nur fit" blendet sie ganz aus |

```
Score = 100 · Basis(VOR) · (1 + w_off · Offense + w_sos · Spielplan) · Gesundheitsfaktor
```

Multiplikativ, nicht additiv: Spielplan und Offense **verschieben** die
Talentbewertung, sie ersetzen sie nicht. Ein leichter Spielplan macht aus einem
WR4 keinen WR1.

Alle Gewichte sind im Board unter **Kriterien** live einstellbar; jede Änderung
sortiert das Board sofort neu. Der Regler *Marktabgleich* zieht das Ergebnis bei
Bedarf Richtung ESPN-ADP — bei 0 % ist es eine reine Eigenbewertung.

**Wichtig zur Spielplan-Komponente:** Vor dem ersten Spieltag existieren für die
laufende Saison noch keine Defense-Werte. Das Board nimmt dann automatisch die
Vorsaison als Baseline und weist das in der Statusleiste und in der Diagnose
aus. Das ist die übliche Vorgehensweise vor einem Draft, aber es ist eine
Annahme über Kaderveränderungen — sie ist keine Prognose der neuen Saison.

---

## Live-Abgleich mit dem ESPN-Draft

Zwei Wege, weil ESPN keine CORS-Freigabe für fremde Webseiten garantiert:

### A) Direkt (bequem, wenn es funktioniert)

League-ID eintragen, **Daten laden**. Das Board fragt die ESPN-API selbst ab und
pollt während des Drafts alle paar Sekunden `mDraftDetail`. Ob der Browser das
zulässt, hängt davon ab, welche CORS-Header ESPN an die Origin des Boards
zurückgibt — und das kann ESPN jederzeit ändern.

### B) Über den ESPN-Tab (der verlässliche Weg)

Ein Bookmarklet läuft im ESPN-Tab selbst. Dort sind die Anfragen
*gleich-origin*: kein CORS, und die Anmeldung an der eigenen (auch privaten)
Liga gilt automatisch. Die Daten gehen per `postMessage` an das Board.

1. Im Board **Setup → Über ESPN-Tab verbinden** öffnen.
2. Den Link **Fantasy-Bridge** in die Lesezeichenleiste ziehen.
   Auf dem iPhone: „Adresse kopieren", ein beliebiges Lesezeichen anlegen und
   die kopierte Adresse als URL einsetzen.
3. Auf `fantasy.espn.com` die Liga bzw. den Draft-Raum öffnen.
4. Das Lesezeichen anklicken. Es öffnet das Board und schickt Spielerpool,
   Spielplan, Defense-Ratings und danach laufend die Draft-Picks hinüber.

Das Bookmarklet überträgt ausschließlich Spieldaten. Cookies, `espn_s2` und
`SWID` verlassen den ESPN-Tab nicht — der Board-Empfänger akzeptiert
Nachrichten zudem nur von ESPN-Origins.

### C) Manuell

Jeder Spieler lässt sich in der Detailansicht als gedraftet markieren.
Picks, die aus ESPN kommen, sind gegen Überschreiben geschützt.

### D) Proxy (Sonderfall)

`proxy/worker.js` ist ein fertiger Cloudflare Worker, der ausschließlich lesende
ESPN-Endpunkte durchreicht. Nur nötig, wenn A scheitert und B nicht in Frage
kommt. Anleitung steht in der Datei.

---

## Veröffentlichen und teilen

GitHub Pages, einmalig:

1. Repository → **Settings → Pages**
2. *Source*: `Deploy from a branch`, Branch `main`, Ordner `/ (root)`
3. Speichern. Nach ein paar Minuten liegt das Board unter
   `https://<benutzer>.github.io/fantasy-draft-board/`

Der Button **Link teilen** erzeugt eine Adresse, die Saison, League-ID und die
eingestellten Gewichte enthält — wer sie öffnet, sieht dasselbe Board. Der
eigene Draft-Fortschritt und die Proxy-Einstellung bleiben lokal im Browser.

Auf dem iPhone: Safari → Teilen → *Zum Home-Bildschirm*. Die Seite läuft dann
wie eine App im Vollbild.

## Lokal ausprobieren

```bash
npm run serve      # http://localhost:8080/
```

ES-Module brauchen einen HTTP-Server; ein Doppelklick auf `index.html`
(`file://`) genügt nicht.

## Tests

```bash
npm test                                       # Logik
npm i -D playwright && npx playwright install chromium
npm run test:e2e                               # Oberflaeche im Browser
```

`npm test` prüft Parser, Bewertungsmodell, Draft-Zustand, Teilen-Link und den
Bookmarklet-Generator. `npm run test:e2e` startet die Seite in Chromium, fängt
alle ESPN-Aufrufe ab und prüft Laden, Filter, Sortierung, Detailansicht,
Draft-Sync, Kader und Layout.

Beide Läufe arbeiten mit synthetischen Antworten im ESPN-Schema und gehen nicht
ins Netz. Die Testdaten bilden das dokumentierte Schema nach; sie ersetzen
keinen Lauf gegen die echte API.

## Aufbau

```
.
├── index.html            Oberfläche
├── assets/app.css        Darstellung (Dark/Light, mobil zuerst)
├── assets/js/espn.js     ESPN-API-Client und Parser
├── assets/js/model.js    Bewertungsmodell (VOR, Offense, SoS, Gesundheit)
├── assets/js/sync.js     Draft-Abgleich: Polling, Bridge, Bookmarklet
├── assets/js/state.js    Konfiguration, localStorage, Teilen-Link
├── assets/js/ui.js       Rendering
├── assets/js/main.js     Verdrahtung
├── proxy/worker.js       Optionaler CORS-Proxy
├── test/run.mjs          Logiktests
├── test/e2e.mjs          Browsertest der Oberflaeche
└── test/fixtures.mjs     Synthetische ESPN-Antworten
```

## Grenzen

- Die ESPN-Fantasy-API ist **nicht offiziell dokumentiert**. Feldnamen und
  Endpunkte können sich ohne Ankündigung ändern. Die Parser sind defensiv
  geschrieben und liefern im Zweifel leere Ergebnisse statt Abstürzen; das
  Panel **Diagnose & Datenquellen** zeigt für jede Anfrage, ob sie geklappt hat.
- Für private Ligen funktioniert nur Weg B (oder ein Proxy mit hinterlegtem
  Cookie).
- Projektionen stammen von ESPN. Das Board gewichtet sie neu, es erstellt keine
  eigenen Prognosen.
