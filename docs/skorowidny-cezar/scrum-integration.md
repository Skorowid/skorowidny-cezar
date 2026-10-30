# SCRUM-LOCAL-01 — zintegrowany moduł lokalny

Status: zakres implementacyjny. Użytkownik potwierdził backlog wewnątrz skorowidny-cezar oraz zlecił działający moduł w cockpit i dopuszcza przełączenie usługi z procedurą rollback. Jira nie jest źródłem danych tego przyrostu.

Pierwszy zintegrowany przyrost obejmuje projektowy Product Goal, Definition of Done, edytowalny Product Backlog, pytania BA i DoR, Sprint Goal i Sprint Backlog, notatnik wydarzeń oraz uruchamianie istniejącego silnika agentów z kontekstem PBI. Stan zapisuje się lokalnie i przeżywa restart. Każda próba agenta jest powiązana z PBI. Ukończenie runu nie oznacza automatycznie ukończenia PBI. Asysta BA jest analizą read-only; nie zatwierdza wymagań za człowieka.

## Granice techniczne dla backendu i UI

- Jeden moduł `packages/contract/src/scrum.ts`, re-eksportowany standardowym barrelem. Wszystkie typy są inferowane z Zod.
- Dane per projekt w `.ai/cezar/scrum/state.json`, atomowy zapis i blokada `proper-lockfile`; dane nie są śledzone w Git. Brak pliku oznacza pusty moduł; uszkodzony plik powoduje jawny błąd, bez zastępowania pustymi danymi.
- Optymistyczna współbieżność: klient podaje `expectedRevision`, serwer zwiększa `revision`; konflikt 409 nie nadpisuje cudzej edycji.
- Brak automatycznych zewnętrznych integracji, harmonogramów lub nowego modelu kont. Obowiązują istniejące granice bezpieczeństwa API Cezara.

### Kontrakt

Eksporty: `scrumStateSchema`, `scrumSaveInputSchema`, `scrumItemParamsSchema`, `scrumLaunchInputSchema`, `scrumLaunchResponseSchema`; typy `ScrumState`, `ScrumItem`, `ScrumSprint`, `ScrumNote`, `ScrumSaveInput`, `ScrumLaunchResponse`.

`ScrumState`:

```text
schemaVersion: 1
revision: integer >= 0
productGoal: string
definitionOfDone: string
items: ScrumItem[]
sprints: ScrumSprint[]
notes: ScrumNote[]
```

`ScrumItem`: `id` (UUID), `title`, `description`, `acceptanceCriteria` (string[]), `dorStatus` (`READY`, `NEEDS CLARIFICATION`, `BLOCKED`, `CHANGE REQUEST`), `approved` (boolean), `questions` (string[]), `priority` (integer >= 1), `dependencies` (UUID[]), `deliveryStatus` (`open`, `in_progress`, `done`), `doneEvidence` (string), `runIds` (UUID[]).

`ScrumSprint`: `id` (UUID), `name`, `goal`, `startsOn`, `endsOn` (ISO calendar dates), `status` (`planned`, `active`, `closed`, `cancelled`), `itemIds` (UUID[]). Zakończone Sprinty zachowują swój plan do inspekcji. Tylko aktywny plan jest źródłem pracy agenta. Nieukończone PBI nie są automatycznie obietnicą następnego Sprintu.

`ScrumNote`: `id` (UUID), `kind` (`general`, `planning`, `daily`, `review`, `retrospective`, `refinement`, `decision`, `question`), `body`, `itemId` (UUID lub null), `sprintId` (UUID lub null), `createdAt` (ISO datetime). Notatki utrwalają ustalenia i pytania; nie zastępują wydarzeń z udziałem ludzi.

### Endpointy projektowe

- `GET /scrum` → `ScrumState`.
- `PUT /scrum` przyjmuje `{expectedRevision, state: ScrumState}` → `ScrumState`. Identyfikatory są unikalne, odwołania muszą istnieć, zależności nie mogą tworzyć cyklu, najwyżej jeden Sprint jest aktywny. Czas Sprintu nie przekracza miesiąca. PBI `done` wymaga Definition of Done i jawnego dowodu/uzasadnienia w `doneEvidence`. Edycja nie może podmieniać historii `runIds` zapisanej przez serwer.
- `POST /scrum/items/:id/launch` przyjmuje `{expectedRevision, mode: 'implement' | 'refine'}` → `{state: ScrumState, runId: UUID}`. Brak PBI: 404; konflikty i brak gotowości: 409. Implementacja wymaga READY, potwierdzenia wymagań, kryteriów, braku otwartych pytań, ukończonych zależności, Product Goal, DoD i przypisania do aktywnego Sprintu z celem. Refinement służy wyjaśnianiu szkiców i nie wymaga READY. Istniejąca aktywna próba tego PBI blokuje podwójne uruchomienie.

Ścieżki są montowane pod standardowym `/api/v1/p/:projectId`. Rodzina Hono ma być chained, a wejścia walidowane middleware. UI używa typowanego klienta.

### Uruchamianie agenta

Rodzina `createScrumRoutes` przyjmuje callback `launch(project: ProjectContext, prompt: string, readOnly: boolean): Promise<{id: string}>`. Callback zapewnia istniejącą kontrolę dostępności providera i `RunManager`; backend Scrum nie tworzy drugiego silnika wykonawczego. Stan PBI zawiera `runIds`; uruchomienia są widoczne również na istniejącej stronie Tasks. Aktywność sprawdzamy w `project.store`, bez globalnych współdzielonych ID projektu.

Kontekst implementacji zawiera cel produktu, cel i plan Sprintu, opis PBI, kryteria, pytania, zależności i DoD. Polecenie wymaga respektowania decyzji BA, zgłaszania nowych luk oraz pracy w standardowym izolowanym worktree, bez auto-merge/push. Refinement nie zmienia kodu produktu ani zatwierdzonych wymagań.

## Weryfikacja przyrostu

Zapisywanie po restarcie; konflikt dwóch klientów; uszkodzony stan; walidacja referencji i cykli; niedopuszczalny okres Sprintu; odmowa implementacji niegotowego PBI; odmowa duplikatu; nieudany start agenta bez fałszywego powiązania; dwa projekty z niezależnym stanem; pełna ścieżka UI create → edit → plan → launch → powiązany run → ręczne potwierdzenie DoD. Screeny wykonujemy z rzeczywistej strony Scrum na syntetycznych danych.

## Odpowiedzialności implementacyjne

Claude: kontrakt Zod, trwały store, rodzina endpointów i testy w nowych modułach. Codex: UI, nawigacja, typowany klient, montaż w serwerze, weryfikacja integracji, dokumentacja, wydanie i przełączenie usługi z rollbackiem. Kontrakt powyżej jest wspólną granicą; nie zmieniamy go jednostronnie w trakcie równoległej pracy.
