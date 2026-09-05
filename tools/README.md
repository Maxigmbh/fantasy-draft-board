# Datenpipeline

`build-data.mjs` erzeugt `assets/data/board.json` aus offenen Quellen. Die
Webseite selbst holt nichts mehr live nach — sie liest nur diese Datei.

## Daten aktualisieren

```bash
mkdir -p ../data-sources && cd ../data-sources
git clone --depth 1 https://github.com/dynastyprocess/data   dp-data
git clone --depth 1 https://github.com/nflverse/nfldata      nfldata
git clone --depth 1 https://github.com/hvpkod/NFL-Data       nfl-stats
cd -
node tools/build-data.mjs ../data-sources 2026
```

Zum Auffrischen genügt `git pull` in den drei Ordnern; DynastyProcess
aktualisiert die FantasyPros-Rankings täglich. Zwei weitere Dateien lädt das
Skript beim ersten Lauf selbst herunter (siehe unten) und cached sie lokal
unter `../data-sources/nflverse-releases/`.

## Quellen

| Quelle | Inhalt | Aktualität |
| --- | --- | --- |
| [dynastyprocess/data](https://github.com/dynastyprocess/data) | FantasyPros ECR (Dynasty, Redraft, Rookies, K, DST), Spieler-Stammdaten mit Alter und Draft-Jahrgang, Dynasty-Handelswerte | täglicher Scrape |
| [nflverse/nfldata](https://github.com/nflverse/nfldata) | Kompletter NFL-Spielplan inklusive Wettquoten | laufend |
| [hvpkod/NFL-Data](https://github.com/hvpkod/NFL-Data) | Fantasy-Punkte je Spieler der letzten zwei Saisons | wöchentlich |
| [nflverse/nflverse-data](https://github.com/nflverse/nflverse-data) (Release-Assets) | Aktueller Rosterstatus (Reserve-Liste) und Tiefenaufstellung der Running Backs | wird selbst heruntergeladen, Stand des Abrufs |

## Wie gerechnet wird

**Basis** ist die Expertenrangliste (ECR), übersetzt in einen Draft-Wert mit
exponentiell fallender Kurve. Der Abstand zwischen Platz 1 und 10 wiegt weit
schwerer als der zwischen 100 und 110.

**Offense-Index** — aus den Wettquoten wird für jedes Spiel die erwartete
Punktzahl beider Teams zerlegt (`total/2 ± spread/2`). Daraus schätzt ein
Ridge-regularisiertes Modell für jedes Team eine Offense- und eine
Defense-Stärke. Die Buchmacher stellen nur für die nächsten Wochen Linien;
das Modell überträgt die Stärken auf den kompletten Spielplan.

**Strength of Schedule** — gewichteter Schnitt der *Gegner-Defensivstärken*
über die Saison, Fantasy-Playoff-Wochen doppelt. Bewusst ohne die eigene
Offense: die steht schon im Offense-Index, sonst zählt dieselbe Teamstärke
zweimal.

```
Score = 100 · Draft-Wert(ECR) · (1 + w_off · Offense + w_sos · Spielplan)
```

**Versteckte Werte** brauchen zuerst ein echtes Signal: der Rosterstatus
(siehe unten) zeigt den Spieler auf der Reserve-Liste — verletzt, PUP oder
NFI. Nur ohne einen solchen Fund greift ersatzweise der Vergleich zwischen
Vorsaison-Platzierung und der aktuellen **Redraft**-Rangliste (nicht Dynasty:
dort fällt ein Spieler auch schlicht wegen seines Alters, das wäre ein
anderes Signal). "Top der Vorsaison" zählt grosszügig über zwei Jahre: wer
letztes Jahr ODER im Jahr davor unter den Top 30 seiner Position lag, zählt
— ein Spieler kann seine gesamte letzte Saison verletzt verpasst haben und
taucht sonst nirgends mehr auf. Ohne aktuelles Team (`team = 'FA'`) oder mit
Rosterstatus `RET`/`CUT` fliegt ein Kandidat in jedem Fall aus der Liste.

## Rosterstatus, Handcuffs und K/DST

**Rosterstatus.** `roster_{season}.csv` (nflverse-Release) meldet je Spieler
einen `status` (u. a. `ACT`, `RES`, `DEV`, `RET`, `CUT`) und einen genaueren
`status_description_abbr`-Code. `RES` ist die Reserve-Liste; die vier
Verletzungs-Subcodes (laut
[nflreadr-Datenwörterbuch](https://nflreadr.nflverse.com/articles/dictionary_roster_status.html))
sind `R01` (IR), `R04` (PUP), `R05` (NFI) und `R48` (IR, Rückkehr in der
Saison möglich). Ein Spieler mit einem dieser vier Codes gilt als
`injuryReserve` und trägt im Board ein rotes Badge. Reine Suspendierung
(`R40`) zählt bewusst nicht als Verletzung. Die Zuordnung läuft über die
`gsis_id`, die `db_playerids.csv` für jede FantasyPros-ID mitliefert
— **Abdeckung 444 von 484 Feldspielern**. Der Status spiegelt den Zeitpunkt
des Datenabrufs, nicht zwangsläufig den Draft-Tag.

**Handcuffs.** `depth_charts_{season}.csv` (ebenfalls ein nflverse-Release,
~47 MB, nur der jeweils neueste Snapshot wird ausgewertet) liefert die
Tiefenaufstellung. Ein Running Back auf Tiefenplatz 2 hinter einem Starter,
der selbst startbar ist (Board-Rang bis 90), bekommt das Backup-Tag — aber
erst ab eigenem Board-Rang 150, sonst wäre er ohnehin schon aus eigenem
Recht gefragt und keine Spätrunden-Wette. Nur RB: das ist der einzige
Positionstyp, bei dem der Ausfall des Starters dem Backup fantasy-relevant
mehr Volumen zuschiebt.

**Kicker und Team-Defenses** kommen ausschliesslich aus ihrer eigenen
Positions-Rangliste (`dynasty-k`, `dynasty-dst`), nicht aus der
positionsübergreifenden "Overall"-Liste. Grund: Die Overall-Liste enthält nur
einen Teil aller K/DST (25 von 36 Kickern, 24 von 32 Defenses beim Aufbau
dieser Funktion) und ordnet sie inkonsistent zur eigenen Positions-Rangliste
— dort etwa war Brandon Aubrey einstimmiger Konsens-Kicker Nummer eins
(`best=worst=1`, `sd=0`), in der Overall-Liste aber Nummer neun unter den
Kickern; bei Houston Texans als klarer Konsens-DST1 dieselbe Verzerrung. Der
1..N-Rang der Positionsliste wird linear auf eine Draft-typische
Spätrunden-Lage abgebildet (`KDST_SCALE` in `build-data.mjs`): das ist eine
offen dokumentierte Modellentscheidung, kein Rohwert von FantasyPros.

## Grenzen

- Offense- und Spielplan-Index sind Team-Werte: alle Spieler eines Teams
  werden gleich verschoben.
- Die Quoten decken nur die vorderen Wochen ab. Die Werte für spätere Wochen
  sind Modellschätzungen, keine Marktpreise.
- Team-Zuordnungen stammen unveraendert aus dem taeglichen FantasyPros-Scrape.
  Bei sehr frischen Transaktionen kann das ueberraschen — die Pipeline
  uebernimmt, was die Quelle zum Abrufzeitpunkt meldet, statt eigene Annahmen
  einzusetzen.
- Rosterstatus und Tiefenaufstellung sind eine Momentaufnahme des Abrufs,
  keine Live-Verbindung zum Draft-Tag. Vor dem Neuaufbau kurz `git pull`
  bzw. den `nflverse-releases`-Cache löschen, um den aktuellen Stand zu holen.

## Alter, Rookie-Status und Marktwert

`db_playerids.csv` liefert Alter, Geburtsdatum und Draft-Jahrgang. Die
Zuordnung läuft über die FantasyPros-ID aus der Rangliste und ist damit
eindeutig; der Name dient nur als Rückfall. Abdeckung: 461 von 484 Spielern.

Als Rookie gilt, wer im Draft der laufenden Saison gezogen wurde oder in der
FantasyPros-Rookie-Rangliste steht.

FantasyPros veröffentlicht seine ADP nicht offen. Statt einer ADP-Spalte
vergleicht das Board deshalb den Dynasty-Handelswert aus `values-players.csv`
mit dem Expertenranking. Der Handelswert entsteht aus tatsächlichen
Tauschgeschäften und ist damit das ehrlichere Marktsignal. Die Abweichung
steht in der Detailzeile, nicht als Tabellenspalte.
