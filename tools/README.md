# Datenpipeline

`build-data.mjs` erzeugt `assets/data/board.json` aus drei offenen Quellen.
Die Webseite selbst holt nichts mehr live nach — sie liest nur diese Datei.

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
aktualisiert die FantasyPros-Rankings täglich.

## Quellen

| Quelle | Inhalt | Aktualität |
| --- | --- | --- |
| [dynastyprocess/data](https://github.com/dynastyprocess/data) | FantasyPros ECR (Dynasty, Redraft, Rookies), Spieler-Stammdaten mit Alter und Draft-Jahrgang, Dynasty-Handelswerte | täglicher Scrape |
| [nflverse/nfldata](https://github.com/nflverse/nfldata) | Kompletter NFL-Spielplan inklusive Wettquoten | laufend |
| [hvpkod/NFL-Data](https://github.com/hvpkod/NFL-Data) | Fantasy-Punkte je Spieler der Vorsaison | wöchentlich |

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

**Versteckte Werte** vergleichen die Positionsplatzierung der Vorsaison mit
der aktuellen **Redraft**-Rangliste — nicht mit der Dynasty-Rangliste. In
Dynasty fällt ein Spieler auch schlicht wegen seines Alters; das wäre ein
anderes Signal.

## Grenzen

- Offense- und Spielplan-Index sind Team-Werte: alle Spieler eines Teams
  werden gleich verschoben.
- Die Quoten decken nur die vorderen Wochen ab. Die Werte für spätere Wochen
  sind Modellschätzungen, keine Marktpreise.
- Es gibt keinen Verletzungs-Feed. Aktuelle Ausfälle stecken indirekt in der
  Redraft-Rangliste und damit in der Liste der versteckten Werte.

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
