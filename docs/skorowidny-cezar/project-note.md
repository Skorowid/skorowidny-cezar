# Notatka projektowa: skorowidny-cezar

Data: 2026-10-30. Wersja: 0.1. Status: fundament techniczny i przykłady; projekt funkcji Scrum do dalszego refinementu.

## Cel i ustalony zakres

Użytkownik zamówił publiczny fork `Skorowid/skorowidny-cezar`, przygotowanie koncepcji i działających przykładów oraz możliwość przejmowania poprawek oryginalnego backendu przy niezależnym rozwoju wyglądu. Pracę nad przykładami backendu powierzono Claude; dokumentację, narzędzia aktualizacji i integrację przygotowuje Codex.

Docelowa potrzeba: backlog z opisami BA, wymagania doprecyzowywane w rozmowie, asystent Scrum Mastera wychwytujący zadania z czatu, notatnik w UI oraz agenci pracujący na izolowanych branchach. To kierunek rozwoju, nie zatwierdzona specyfikacja zachowania wszystkich tych funkcji.

## Co jest gotowe w pierwszym przyroście

- Historia oryginalnego repozytorium pozostaje zachowana; fork ma być powiązany z `open-mercato/cezar` w GitHub. Domyślna gałąź rozwoju to `skorowidny/main`; odziedziczonego `main` nie nadpisujemy.
- `fork/upstream.json` zapisuje dokładny commit bazowy, źródło i wersję pakietu.
- `fork/tools/upstream_report.py` generuje raport zmian upstreamu i forka bez zmieniania gałęzi, plików źródłowych lub zdalnego repozytorium.
- [Koncepcja Scrum](scrum-concept.md) obejmuje fundamenty, wartości, odpowiedzialności, wydarzenia, artefakty, zobowiązania, diagram oraz otwarte decyzje.
- [Przykłady backendu](../../examples/skorowidny-scrum/backend/README.md) pokazują wybrane mechanizmy lokalne i ich testowanie na danych syntetycznych.
- [Procedura utrzymania](upstream-maintenance.md) opisuje pełne aktualizacje i selektywne przejmowanie poprawek oraz ochronę własnego UI.

## Co pozostaje projektem

Backlog i notatnik nie są jeszcze wpięte w cockpit. Nie ma nowych produkcyjnych endpointów, nowego modelu uprawnień, automatycznego przejmowania wymagań z czatu ani automatycznego scalania kodu agentów. Przykłady nie uruchamiają agentów i nie udają kompletnej implementacji Scruma.

Nie wdrożono forka na istniejącą usługę Cezara. Publikacja repozytorium jest oddzielna od wdrożenia aplikacji i publikacji pakietów npm.

## Podział kodu i możliwość aktualizacji

| Obszar | Ścieżka | Polityka |
|---|---|---|
| Backend i CLI upstream | `packages/cezar/` | Na starcie bez zmian forka; przyszłe rozszerzenia w małych, jawnych commitach |
| Wspólny kontrakt | `packages/contract/` | Jedno źródło schematów Zod; zmiany koordynowane z backendem i UI |
| Klient API | `packages/api-client/` | Zachowanie typowanych granic upstreamu |
| Własny wygląd | `packages/web/` | Przyszłe zmiany wizualne w osobnych commitach, bez duplikowania backendu |
| Desktop | `packages/desktop/` | Sprawdzać zależności UI i zgodność przy aktualizacjach |
| Rozszerzenia referencyjne | `examples/skorowidny-scrum/` | Oddzielone od produkcyjnego runtime, bez nowych zależności aplikacji |
| Utrzymanie forka | `fork/`, `docs/skorowidny-cezar/` | Dokumentacja, baza porównania, narzędzia i testy |

Nie kopiujemy całego backendu do drugiego katalogu. Taki duplikat szybko utrudniłby przejmowanie poprawek. Nie obiecujemy też bezkonfliktowej automatycznej aktualizacji: poprawka backendu może wymagać nowego kontraktu, migracji, lockfile lub zmian klienta.

W pierwszym przyroście zakresy `packages/cezar`, `packages/contract`, `packages/api-client`, `packages/web` oraz `packages/desktop` powinny być identyczne z bazą. Można to sprawdzić:

```bash
git diff --exit-code eb157816aac7e0d4676c007e2f7d14b397588784 HEAD -- packages/cezar packages/contract packages/api-client packages/web packages/desktop
```

## Wybór technologii

Produkcja pozostaje w istniejącym stosie: TypeScript, Hono, Zod i React. Przykłady narzędzi lokalnych używają Pythona i biblioteki standardowej; nie wprowadzają drugiego serwera aplikacji ani obowiązkowej bazy do Cezara. Ewentualne przeniesienie prototypu do TypeScript i wpięcie w istniejący kontrakt wymaga osobnej specyfikacji i testów.

Oszczędzanie tokenów ma polegać na deterministycznym wyszukiwaniu, obliczeniach, walidacji i pobieraniu fragmentów dokumentów. Agent dostaje wersjonowany pakiet zadania i zależności. Nie pomijamy wyjątków i reguł przekrojowych tylko dla zmniejszenia promptu.

## Gotowość i następne decyzje

| ID | Status | Zakres / decyzja |
|---|---|---|
| FOUNDATION-01 | READY | Publiczny fork, dokumentacja i izolowane przykłady zostały zamówione przez użytkownika |
| SCRUM-01 | NEEDS CLARIFICATION | Wskazanie produktu, PO, SM, BA/SA i właściciela decyzji biznesowych |
| SCRUM-02 | NEEDS CLARIFICATION | Źródło prawdy backlogu: Jira, Cezar czy wersjonowane pliki |
| SCRUM-03 | NEEDS CLARIFICATION | Długość Sprintu, wydarzenia, udział ludzi i zasady potwierdzania ustaleń |
| SCRUM-04 | NEEDS CLARIFICATION | Produkcyjny kontrakt backlogu, pytania, notatki, DoR i DoD |
| UI-01 | NEEDS CLARIFICATION | Docelowy wygląd i pierwszy konkretny ekran do zmiany |

Właściciele decyzji: użytkownik wskazuje osoby; PO odpowiada za wartość i kolejność backlogu, upoważniony BA/SA za potwierdzenie reguł, Developers za plan i rozwiązanie techniczne. Otwartych pytań przyszłych funkcji nie używamy do blokowania gotowego fundamentu technicznego.

Proponowany pierwszy przyrost produktu po fundamencie: karta PBI z opisem, źródłem, pytaniami i powiązaniem z istniejącym runem. Przed implementacją należy uzgodnić aktorów, zapis i edycję, walidację, błędy, dostęp i testowalne kryteria. Pozostałe moduły można doprecyzowywać później.

## Weryfikacja i publikacja

Przed publikacją uruchamiamy testy przykładów i narzędzia porównania oraz wymagane w `AGENTS.md` typecheck, Vitest, testy core, build i testy paczki. Faktyczne wyniki i ograniczenia są zapisane w [rejestrze zmian](changes.md). Nie przedstawiamy przykładu jako produkcyjnego backlogu, a testów syntetycznych jako potwierdzenia zatwierdzonych wymagań biznesowych.

Publikujemy wyłącznie kod repozytorium, dokumentację projektu i dane syntetyczne. Pliki sesji, załączniki użytkownika, dane działającego Cezara i konfiguracja kont nie należą do tego przyrostu.
