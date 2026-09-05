# Fantasy Draft Board

Ein eigenes Draftboard nach dem Vorbild von FantasyPros: Spieler in Tiers,
sortier- und filterbar nach Position, mit dem Expertenranking als Spalte —
ergänzt um zwei Dinge, die dort fehlen: wie stark die Offense des jeweiligen
Teams projiziert ist und wie der Spielplan über die Saison aussieht.

Dazu zwei Nebenlisten: **Rookies & Breakouts** für die späten Runden und
**Versteckte Werte** für Spieler, die zuletzt stark produziert haben und
aktuell auffällig tief gehandelt werden.

Die Seite ist statisch und holt zur Laufzeit nichts nach. Alle Daten stehen in
`assets/data/board.json`, erzeugt von `tools/build-data.mjs` aus drei offenen
Quellen.

---

## Die drei Ansichten

**Board** — die Gesamtliste, gruppiert in Tiers. Standardmäßig ist nur der
erste Tier aufgeklappt; jeder weitere öffnet sich per Klick auf die Kopfzeile.
Die Vorschau rechts zeigt, wer in einem zugeklappten Tier steckt. Positionsfilter
(inklusive FLEX), Suche und sechs Sortierungen. Ein Klick auf eine Zeile zeigt
Kennzahlen und den kompletten Wochenspielplan; dort lässt sich ein Spieler auch
als vergeben markieren.

**Rookies & Breakouts** — Rookies und Spieler ohne nennenswerte Vorsaison, die
erst ab der vierten Runde gehandelt werden.

**Versteckte Werte** — Spieler, die letztes Jahr oder im Jahr davor unter den
Top 30 ihrer Position lagen, ein aktuelles Team haben und gerade auf der
Reserve-Liste stehen (verletzt, PUP oder NFI) — sie starten die Saison
verspätet. Nur wenn kein solcher Fund vorliegt, greift ersatzweise der
Vergleich mit der aktuellen **Redraft**-Rangliste (nicht Dynasty: dort fällt
ein Spieler auch schlicht wegen seines Alters, das wäre ein anderes Signal).
In dieser Ansicht taucht zusätzlich das **Backup**-Tag auf: Running Backs, die
bei einem Ausfall des jeweiligen Starters selbst zum Starter würden — die
klassische Spätrunden-Absicherung.

## Die Spalten

Layout und Spalten folgen der FantasyPros-Vorlage, ergänzt um die eigenen
Kennzahlen. Standardabweichung und ECR-gegen-ADP sind bewusst nicht in der
Tabelle — Erstere steht in der Detailzeile, Letztere gibt es in keiner offenen
Quelle.

| Spalte | Bedeutung |
| --- | --- |
| **RK** | Rang nach eigener Bewertung |
| **☑** | Spieler als vergeben markieren |
| **Pick** | Runde und Pick bei 12 Teams |
| **Spieler (Team)** | Name und NFL-Team |
| **Pos** | Position mit Rang innerhalb dieses Boards |
| **Alter** | Alter in Jahren |
| **Best / Worst** | bester und schlechtester Einzelrang unter den Experten |
| **ECR** | Expert Consensus Ranking von FantasyPros, darunter klein die Position, auf der er letzte Saison abgeschlossen hat (z. B. "RB4 '25") |
| **Bye** | spielfreie Woche |
| **Off** | Offense-Index des NFL-Teams, aus Wettquoten geschätzt |
| **SoS** | Spielplan: wie durchlässig die Gegner-Defenses über die Saison sind |
| **Score** | eigene Bewertung aus ECR plus den beiden Indizes |

Grün und rot markieren Ausschläge über ±15 Punkte. Badges am Namen zeigen: ein
rotes Feld mit **IR/PUP/NFI**, wenn der Spieler gerade auf der Reserve-Liste
steht; **Backup**, wenn er als Handcuff für einen Starter markiert ist;
**Rookie**; sowie **Wert**/**Reach**, wenn er deutlich später oder früher
gehandelt würde, als das Board ihn führt. Ein Klick auf die Zeile öffnet
Kennzahlen, Wochenspielplan, Rosterstatus und den Vergleich mit dem
Dynasty-Handelswert.

## Wie gerechnet wird

```
Score = 100 · Draft-Wert(ECR) · (1 + w_off · Offense + w_sos · Spielplan)
```

Basis ist das Expertenranking, übersetzt in einen Draft-Wert mit exponentiell
fallender Kurve: der Abstand zwischen Platz 1 und 10 wiegt weit schwerer als
der zwischen 100 und 110. Offense und Spielplan verschieben diesen Wert um
höchstens ±30 %, sie ersetzen ihn nicht. Stehen beide Regler auf 0 %, steht
exakt die FantasyPros-Rangliste.

Beide Indizes stammen aus den Wettquoten des kompletten Spielplans. Für jedes
Spiel lässt sich aus Over/Under und Spread die erwartete Punktzahl beider Teams
zerlegen; daraus schätzt ein Ridge-regularisiertes Modell für jedes Team eine
Offense- und eine Defense-Stärke. Die Buchmacher stellen nur für die vorderen
Wochen Linien, das Modell überträgt die Stärken auf die restliche Saison. Auf
zurückgehaltenen Spielen liegt der mittlere Fehler bei 1.29 Punkten gegenüber
2.01 ohne Modell.

Der Spielplan-Index mittelt ausschließlich die **Gegner**-Defensivstärken,
Fantasy-Playoff-Wochen doppelt gewichtet. Die eigene Offense bleibt außen vor —
sie steht schon im Offense-Index, sonst zählt dieselbe Teamstärke zweimal.

Tiers entstehen dort, wo der *relative* Abstand zum nächsten Spieler auffällt.
Absolut gemessen wäre am Anfang der Liste jeder Spieler ein eigener Tier.

Details und die Grenzen des Ansatzes: [`tools/README.md`](tools/README.md).

## Daten aktualisieren

```bash
mkdir -p ../data-sources && cd ../data-sources
git clone --depth 1 https://github.com/dynastyprocess/data dp-data
git clone --depth 1 https://github.com/nflverse/nfldata    nfldata
git clone --depth 1 https://github.com/hvpkod/NFL-Data     nfl-stats
cd - && node tools/build-data.mjs ../data-sources 2026
```

DynastyProcess aktualisiert die FantasyPros-Rankings täglich; zum Auffrischen
genügt danach `git pull` in den drei Ordnern.

## Veröffentlichen

GitHub Pages: **Settings → Pages**, Source `Deploy from a branch`, Branch
`main`, Ordner `/ (root)`. Die Seite liegt dann unter
`https://<benutzer>.github.io/fantasy-draft-board/`.

## Lokal

```bash
npm run serve      # http://localhost:8080/
```

Ein Doppelklick auf `index.html` genügt nicht — ES-Module und `fetch` brauchen
einen HTTP-Server.

## Tests

```bash
npm test                                       # Logik gegen die echte Datendatei
npm i -D playwright && npx playwright install chromium
npm run test:e2e                               # Oberflaeche in Chromium
```

`npm test` prüft Struktur und Integrität der Datendatei, die Bewertung, Filter,
Tiers, beide Nebenlisten und die Bausteine der Pipeline — unter anderem, dass
das Team-Rating-Modell bekannte Stärken aus synthetischen Daten wiederfindet.
`npm run test:e2e` fährt die Seite in Chromium hoch und prüft Aufklappen,
Filter, Sortierung, Regler, Detailansicht und beide Nebenlisten.

## Aufbau

```
.
├── index.html            Oberfläche
├── assets/app.css        Darstellung (Dark/Light, für breite Bildschirme)
├── assets/js/board.js    Datenmodell: Bewertung, Filter, Tiers
├── assets/js/main.js     Oberfläche und Ereignisse
├── assets/data/board.json  erzeugte Datendatei
├── tools/build-data.mjs  Pipeline
└── test/                 Logik- und Browsertests
```

## Grenzen

- Offense- und Spielplan-Index sind Team-Werte: alle Spieler eines Teams
  verschieben sich gemeinsam.
- Quoten liegen nur für die vorderen Wochen vor; spätere Werte sind
  Modellschätzungen, keine Marktpreise.
- Der Rosterstatus (Reserve-Liste, Handcuffs) ist eine Momentaufnahme des
  Datenabrufs, keine Live-Verbindung zum Draft-Tag — vor einem wichtigen
  Draft lohnt sich ein frischer Lauf der Pipeline.
- Team-Zuordnungen übernimmt die Pipeline unverändert aus dem täglichen
  FantasyPros-Scrape. Bei sehr frischen Transaktionen kann das überraschen;
  Details in [`tools/README.md`](tools/README.md).
- Die Rankings stammen von FantasyPros und sind deren Werk; die Seite bündelt
  sie nur mit eigenen Kennzahlen und weist die Quelle aus.
