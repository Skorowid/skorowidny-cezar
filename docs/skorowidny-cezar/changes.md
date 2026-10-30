# Zmiany skorowidny-cezar

## 2026-10-30 — własne README i aktualne screeny

Zastąpiono skopiowaną stronę główną upstreamu opisem skorowidny-cezar: zakresem gotowych dodatków, ich statusem, uruchamianiem z checkoutu forka i planem niezależnego rozwoju UI. Usunięto z głównego README oryginalne materiały promocyjne, nagranie, odznaki npm i odziedziczoną galerię screenów. Pochodzenie projektu i odnośnik do bazowej dokumentacji pozostają jawne.

Dodano trzy własne screeny: rzeczywisty cockpit z izolowanej sesji dry-run oraz widoki dokumentacyjne rzeczywistych wyników backendu i porównania upstreamu. Podpisy rozróżniają istniejące UI od przykładów, które nie są jeszcze ekranami aplikacji. Obok obrazów zapisano źródłowe JSON-y i opis ich pochodzenia. Nie użyto danych ani sesji użytkownika.

Ta aktualizacja dotyczy dokumentacji i obrazów; nie zmienia kodu aplikacji, domyślnego brandingu ani działającej usługi. Samodzielne uruchomienie repozytorium nadal pokazuje odziedziczony cockpit, a nazwę jak na screenie można ustawić funkcją brandingu profilu.

## 2026-10-30 — fundament publicznego forka

Baza: `open-mercato/cezar`, commit `eb157816aac7e0d4676c007e2f7d14b397588784`, wersja pakietu `0.17.0` na `main`.

Dodano dokumentację kierunku Scrum + AI, notatkę projektową, procedurę utrzymania upstreamu i narzędzie raportujące różnice. Przykłady backendu pokazują lokalne mechanizmy na danych syntetycznych. README odróżnia ten przyrost od gotowej aplikacji Scrum i od oryginalnej dystrybucji npm.

Core backendu, klienta API, kontraktów, UI i desktopu pozostaje bez zmian względem bazy. W tym przyroście nie wprowadzamy własnego updatera, nowej nazwy pakietu npm ani wdrożenia na serwerze. Przyszłe zmiany wyglądu oraz produkcyjny moduł backlogu będą osobnymi przyrostami.

### Weryfikacja

Weryfikacja lokalna: Linux, Node 24.21.0, Python 3.14.4. Claude przygotował przykłady backendu, Codex przejrzał kod i powtórzył testy; po przeglądzie dodano 11 testów regresji i poprawki.

| Sprawdzenie | Wynik |
|---|---|
| `npm ci` | PASS |
| `npm run typecheck` | PASS |
| Przykłady backendu, `unittest` | PASS — 54 testy |
| Narzędzie porównania upstreamu, `unittest` | PASS — 8 testów |
| Demo backendu | PASS — JSON obejmujący 12 kroków |
| `npm run test:unit` | PASS — 48 testów |
| `npm run build`, w tym `check:pack` | PASS — 1102 pliki w paczce, 167 plików web |
| `npm run test:package` | PASS — 33 testy |
| Pełny Vitest w odziedziczonym środowisku cockpit | FAIL — 12798 passed, 68 failed, 4 skipped; część błędów dotyczy `CEZ_AGENT_MODELS_LOCKED=1` |
| Pełny Vitest po usunięciu zmiennych sesji, `--maxWorkers=4` | TIMEOUT po 600 s; nie uznajemy tej próby za zakończony lub zielony suite |
| Osobne powtórzenie 4 plików UI, `--maxWorkers=1` | 76 passed, 2 failed — oczekiwanie na załadowanie diffu |

Pozostałe błędy w osobnym uruchomieniu dotyczą `packages/web/src/components/diff/line-comments.test.tsx` (przypadek bez komentarzy) i `packages/web/src/routes/task-git/task-commits.test.tsx` (kolumna diffu commita). W tej maszynie testy czekały na treść diffu zbyt krótko; pliki testów i kod UI są identyczne z bazą upstream. Nie rozstrzygamy tu, czy to problem czasu środowiska czy usterka upstreamu. Nie zmieniano testów ani core, aby ukryć wynik. Pełna walidacja upstreamu pozostaje niezielona.

Przykłady są samodzielną referencją, nie produkcyjnym backendem Scrum. SQLite jest testowane lokalnie, bez pracy wielohostowej; nie ma uprawnień, migracji ani heartbeat. Kontekst nie ma limitu rozmiaru/FTS i nie jest podpisany kryptograficznie. Kalkulator jawnie ujawnia precyzję 50 cyfr i utratę precyzji; nie deklaruje dowolnej dokładności.

GitHub Actions w forku są wyłączone. Własny workflow testów jest przygotowany, ale nie ogłaszamy zdalnego CI jako wykonanego. Przed jego włączeniem trzeba ograniczyć odziedziczone mechanizmy publikacji upstreamu.
