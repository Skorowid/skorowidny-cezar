# Screeny skorowidny-cezar

Data wykonania: 2026-10-30. Źródło checkoutu: `56ecd741639161017e707cff56fa60a4ae17574e`. Są to screeny wykonane przeglądarką Chromium, nie wygenerowane obrazy ani projekty nieistniejącego UI.

| Plik | Co pokazuje | Pochodzenie danych |
|---|---|---|
| `cockpit-demo.png` | Rzeczywisty ekran Tasks aplikacji uruchomionej z checkoutu; nazwa `skorowidny-cezar` ustawiona istniejącą funkcją brandingu | Osobny profil `CEZ_HOME`, lokalne repo demo, `CEZ_DRY_RUN=1`; zadanie, referencja i metryki pochodzą z mocka |
| `backend-example.png` | Zwięzły widok dokumentacyjny wyników przykładu Python | [Pełny JSON demonstracji](backend-output.json) z `python3 -m skorowidny_scrum_example.demo` |
| `upstream-comparison.png` | Widok dokumentacyjny raportu różnic Git | [Pełny raport JSON](upstream-report.json) z `python3 fork/tools/upstream_report.py --format json --stdout` |

Drugi i trzeci screen przedstawiają rzeczywiste dane wyjściowe sformatowane jako czytelny dokument HTML i sfotografowane w przeglądarce. Nagłówki i układ służą prezentacji w README; nie są nowymi ekranami aplikacji ani zapisem terminala. Źródłowe JSON-y pozwalają sprawdzić pokazane wyniki.

Cockpit zachowuje odziedziczony układ upstreamu. Branding demo nie zmienia domyślnej konfiguracji produktu i nie dowodzi implementacji nowego modułu Scrum. W screenshotach nie wykorzystano działającej sesji użytkownika, jego projektów, załączników ani kont modeli.

## Odtworzenie danych

Z katalogu głównego repozytorium:

```bash
PYTHONPATH=examples/skorowidny-scrum/backend \
  python3 -m skorowidny_scrum_example.demo > /tmp/backend-output.json

python3 fork/tools/upstream_report.py --format json --output /tmp/upstream-report.json
```

UUID rezerwacji w demonstracji są losowe. Raport Git zależy od `HEAD` i lokalnie znanego `upstream/main`; screen wskazuje konkretne SHA. W snapshotach źródłowych znajdują się wyłącznie syntetyczne dane demonstracji i publiczne metadane Git.

Podgląd cockpit uruchomiono na osobnym wolnym porcie, z `CEZ_DRY_RUN=1`, `CEZ_SKILLS_AUTO_UPDATE=0`, `CEZ_TELEMETRY=0` i `CEZ_NO_BANNER=1`. Osobny profil miał `branding.name = "skorowidny-cezar"` oraz jedno lokalne repo demonstracyjne. Zdjęcie obejmuje stronę `/tasks` przy szerokości 1440 px. Pozostałe widoki dokumentacyjne mają tę samą szerokość.

Przy odtwarzaniu należy użyć osobnego profilu i danych syntetycznych; zrzuty aktywnej instalacji mogą ujawniać treść zadań i nazwy projektów. Tymczasowy podgląd po wykonaniu screenów jest zatrzymywany; nie stanowi wdrożenia forka.
