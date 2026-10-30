# Przykłady backendu: lokalny backlog Scrum (prototyp referencyjny)

Autor: Skorowid. Data: 2026-10-30. Status: **przykład uruchamialny, nie zatwierdzone zachowanie produktu.**

Mały, samodzielny prototyp w Pythonie (wyłącznie biblioteka standardowa) ilustrujący wybrane mechanizmy z koncepcji [Scrum + AI](../../../docs/skorowidny-cezar/scrum-concept.md):

1. lokalny backlog w SQLite i **atomowa rezerwacja** (claim) zadania z jawnie gotowej pracy Sprintu,
2. **kompaktowy kontekst** zadania z jawnymi wersjami dokumentów,
3. obliczenia na `Decimal` z **jawnym zaokrągleniem** wskazanym przez regułę.

Czego to NIE jest:

- nie jest zintegrowane z produkcyjnym backendem Cezara (`packages/cezar` pozostaje bez zmian) i nie jest przez niego importowane,
- nie ma serwera API, endpointów, UI, uruchamiania agentów ani pełnej implementacji Scruma,
- nie łączy się z żadną usługą zewnętrzną, nie używa poświadczeń ani danych produkcyjnych — wszystkie dane są syntetyczne,
- reguły opisane niżej są **przykładową polityką** dobraną do demonstracji; decyzję o rzeczywistych regułach podejmuje właściciel wymagań.

## Wymagania i polecenia

Python 3 (sprawdzone na 3.14.4), bez zależności zewnętrznych. Wszystkie polecenia uruchamiaj z katalogu tego README:

```bash
cd examples/skorowidny-scrum/backend

# testy (unittest z biblioteki standardowej)
python3 -m unittest discover -s tests -t . -v

# demo: wypisuje JSON na stdout tylko przy jawnym uruchomieniu
python3 -m skorowidny_scrum_example.demo
python3 -m skorowidny_scrum_example.demo --ttl 300 --db /tmp/demo-backlog.sqlite3   # plik nie może jeszcze istnieć
```

Z katalogu głównego repozytorium (tak jak w CI forka):

```bash
timeout 120 python3 -m unittest discover -s examples/skorowidny-scrum/backend -p 'test_*.py' -v
```

Import z własnego skryptu (katalog `backend/` musi być w `sys.path`, np. bieżącym katalogiem lub przez `PYTHONPATH=examples/skorowidny-scrum/backend`):

```python
from skorowidny_scrum_example import (
    BacklogStore, DEFAULT_RULES, build_context, calculate, load_fixture, load_rules,
)

with BacklogStore(":memory:") as store:          # lub ścieżka do pliku .sqlite3
    load_fixture(store)                           # fixtures/sample_backlog.json
    claim = store.claim_next("SPR-1", run_id="run-1", ttl_seconds=900)
    context = build_context(store, claim.task_id)
    store.complete(claim.claim_id, "run-1")

result = calculate(load_rules(DEFAULT_RULES), "SAMPLE-SUM-HOURS", {"values": ["0.125", "0.5"]})
# result["result"] == "0.62" (ROUND_HALF_EVEN do 0.01), result["unrounded"] == "0.625", result["inexact"] is False
```

Moduły biblioteki nic nie wypisują na stdout; sprawdza to test `test_library_import_and_use_write_nothing_to_stdout`.

## Przykładowa polityka (jawna, niezatwierdzona)

### Rezerwacja pracy — `store.py`

| Reguła przykładowa | Zachowanie |
|---|---|
| Kwalifikacja | Zadanie należy do wskazanego Sprintu, Sprint ma status `active`, `dor_status = READY`, `approved = true`, `exec_status = open`, wszystkie zależności mają `exec_status = done`. |
| Kolejność | `claim_next` wybiera najniższe `sprint_order` (remis: ID). Kolejność jest jawnym polem fixture; nic nie jest wnioskowane. |
| Wyjaśnienie | `explain(sprint_id)` zwraca dla każdego zadania listę niespełnionych warunków (`[]` = kwalifikuje się); dla nieaktywnego Sprintu każda lista zaczyna się od `sprint_status=<status>`, tak jak w `claim_next`. `NotClaimableError.reasons` niesie tę samą listę. |
| Duplikat | Jeden run ma najwyżej jedną aktywną rezerwację. Ponowienie `claim_next` przez ten sam run **w tym samym Sprincie** zwraca istniejącą rezerwację (`reused = true`) zamiast tworzyć drugą. Ten sam run pytający o inny Sprint, gdy trzyma rezerwację → `ClaimConflictError` (techniczny niezmiennik przykładu, nie reguła produktowa). Inny run → `ClaimConflictError`. |
| Ważność | Wywołujący zawsze podaje `ttl_seconds` (dodatnia liczba całkowita) — brak wartości domyślnej. Rezerwacja wygasa w chwili `claimed_at + ttl`. |
| Wygaśnięcie | Wygasła rezerwacja **nie jest przejmowana po cichu**: zadanie zostaje `claimed`, `complete` zwraca `ClaimExpiredError`, a `expired_claims()` ją wykazuje. Dopiero `recover_expired(task_id, note)` z wymaganą notatką zamyka ją jako `recovered` i przywraca zadanie do `open`. |
| Atomowość | Każda zmiana działa w `BEGIN IMMEDIATE`; częściowe indeksy UNIQUE blokują drugą aktywną rezerwację tego samego zadania lub runu. |
| Kontekst a rezerwacja | Rezerwacja nie sprawdza dokumentów. Błąd kontekstu wykrywa `build_context`; wywołujący decyduje, czy wtedy wywołać `release`. To świadome rozdzielenie w przykładzie, nie rekomendacja produktowa. |

Statusy DoR są wartościami z instrukcji użytkownika: `READY`, `NEEDS CLARIFICATION`, `BLOCKED`, `CHANGE REQUEST`. Statusy realizacji `open`/`claimed`/`done` oraz Sprintu `planned`/`active`/`closed` są nazwami roboczymi przykładu.

### Kontekst zadania — `context.py`

- Zadanie wskazuje dokumenty parami `(doc_id, version)`; builder nigdy nie podstawia „najnowszej” wersji.
- Wskazana wersja musi istnieć (`MissingContextError`), mieć status `approved` (`UnapprovedContextError`) i być najnowszą zatwierdzoną wersją dokumentu (`StaleContextError`).
- Pakiet zawiera zadanie z wersją i kryteriami, cel Sprintu, zależności ze statusem oraz streszczenia dokumentów. Treść dokumentów jest pominięta i oznaczona w `omitted`; pełny tekst zwraca `get_document(store, doc_id, version)`. Każdy dokument niesie `body_sha256` (SHA-256 treści), więc edycja treści przy tej samej wersji jest wykrywana bez przesyłania tekstu.
- `context_key` to SHA-256 kanonicznego JSON pakietu (z wersją generatora, obecnie `example-context/2`). `verify_context`:
  - zgłasza `InvalidInputError`, gdy pakiet ma złą strukturę (brak/zły typ `task.id` lub `context_key`, wartości spoza JSON) albo jego treść nie zgadza się z własnym `context_key` (pakiet zmieniony po zbudowaniu),
  - przebudowuje pakiet i zgłasza `StaleContextError`, jeśli zmienił się stan bazy (np. nowa zatwierdzona wersja dokumentu, edycja treści dokumentu, edycja zadania, zmiana statusu zależności).

### Obliczenia — `calc.py`, `fixtures/sample_rules.json`

- Reguła ma `rule_id`, `version`, `operation` (`sum` albo `percent_of`), `quantum` (potęga dziesięciu jako tekst, np. `"0.01"`) i `rounding` (nazwa trybu z modułu `decimal`). Nie ma domyślnego zaokrąglenia.
- Wejścia: `str`, `int` lub `Decimal`. `float` i `bool` są odrzucane, podobnie NaN/Infinity, puste listy, nadmiarowe klucze i dzielenie przez zero.
- Wejścia są reprezentowane dokładnie, ale arytmetyka działa z precyzją `PRECISION = 50` cyfr znaczących (wybór przykładu, nie zatwierdzona precyzja biznesowa). Wynik **nie jest deklarowany jako matematycznie dokładny**: zawiera wejścia, wartość przed zaokrągleniem reguły (`unrounded`), `precision`, flagę `inexact`, wynik zaokrąglony, wersję reguły oraz ostrzeżenia — gdy obliczenie pośrednie straciło cyfry (np. `2/3`, operand dłuższy niż 50 cyfr) i gdy zaokrąglenie reguły zmieniło wartość.
- Wartości, których kontekst nie reprezentuje (przepełnienie wykładnika, wynik wymagający po kwantyzacji więcej niż 50 cyfr, np. `1e60` do `0.01`), dają `InvalidInputError`, a nie surowy wyjątek `decimal`.
- `SAMPLE-SUM-HOURS` (ROUND_HALF_EVEN, 0.01) i `SAMPLE-PERCENT-DONE` (ROUND_HALF_UP, 0.1) to wyłącznie ilustracje trybów zaokrąglania.

## Dane syntetyczne — `fixtures/sample_backlog.json`

Każda pozycja ma `_comment` mówiący, którą gałąź polityki ilustruje:

| Pozycja | Stan | Efekt w przykładzie |
|---|---|---|
| PBI-101 | READY, zatwierdzona, poprawny kontekst | rezerwowana jako pierwsza |
| PBI-102 | zależy od PBI-101 | dostępna po ukończeniu PBI-101 |
| PBI-103 / 104 / 105 / 109 | BLOCKED / niezatwierdzona / NEEDS CLARIFICATION / CHANGE REQUEST | nigdy nierezerwowane |
| PBI-106 / 107 / 108 | READY, ale odwołanie nieaktualne / do szkicu / do brakującego dokumentu | rezerwowalne; `build_context` zgłasza odpowiedni błąd |
| PBI-110 | poza Sprintem | nierezerwowana |
| PBI-201 | w Sprincie `planned` | nierezerwowana |

Loader odrzuca nieznane klucze, złe enumeracje, brakujące `sprint_order`, nieistniejące zależności i duplikaty — cała fixture ładuje się w jednej transakcji albo wcale.

## Pliki

```text
backend/
  README.md
  fixtures/sample_backlog.json      synthetic backlog, sprints, documents
  fixtures/sample_rules.json        sample Decimal rules
  skorowidny_scrum_example/
    __init__.py                     public API
    errors.py                       error types
    store.py                        SQLite schema, claim/complete/release/recover
    context.py                      compact context, verify_context, get_document
    calc.py                         Decimal rules and calculate()
    fixtures.py                     fixture validation and loading
    demo.py                         demo driver (JSON on explicit run only)
  tests/
    helpers.py                      fixed clock, temp DB, synthetic generators
    test_store.py                   policy, duplicates, expiry, invalid input, concurrency
    test_context.py                 versions, missing/unapproved/stale context
    test_calc.py                    rounding, invalid inputs and rules
    test_review_regressions.py      regressions for review of task 4914edaf
    test_fixtures_and_demo.py       fixture validation, stdout silence, demo
```

## Ograniczenia

- Współbieżność jest testowana wątkami z osobnymi połączeniami do jednego pliku SQLite na jednej maszynie. Nie obejmuje sieciowych systemów plików ani wielu hostów.
- Czas pochodzi z wstrzykiwanego zegara (`clock`); przykład nie obsługuje przesunięć zegara między procesami ani przedłużania rezerwacji (heartbeat).
- Brak modelu uprawnień, ról, historii zmian zadania i migracji schematu. Schemat tworzy się przy otwarciu bazy.
- Kontekst nie ma limitu rozmiaru ani wyszukiwania (np. FTS5) — to kolejne kandydatury do refinementu.
- Kontrola `context_key` wykrywa zmianę pakietu, nie jest podpisem: kto zmieni treść i przeliczy klucz, przejdzie kontrolę spójności, ale nadal zostanie porównany ze świeżo zbudowanym pakietem z bazy.
- Odzyskanie wygasłej rezerwacji tylko zapisuje notatkę; weryfikacja pozostawionych zmian (branch/worktree) jest poza zakresem przykładu.
