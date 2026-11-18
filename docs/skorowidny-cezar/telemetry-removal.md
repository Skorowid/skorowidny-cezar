# Usunięcie telemetrii i automatycznych połączeń z Open Mercato

Autor: Skorowid. Data: 2026-11-18. Status: zmiany na `skorowidny/main`, **jeszcze niewdrożone** — wdrożenie i testy przejmuje drugi cezar.

## Decyzje właściciela

- Fork zostaje na linii **0.19** (wersja produkcyjna `0192afa4-codexnet2`). Scalenie upstream 0.20 (`e7ce920c`) zostało cofnięte przez `git revert` na `skorowidny/main` — bez przepisywania historii. Powód: 0.20 nie daje wglądu w podprocesy dispatchu.
- Kod wysyłający dane do Open Mercato albo pobierający i uruchamiający ich kod bez polecenia użytkownika jest **usunięty**, nie wyłączony.
- Połączenia z dostawcami agentów (Claude, Codex itd.) nie są objęte tą zmianą.
- Świadomie pozostawione (decyzja właściciela, 2026-11-18): sprawdzanie nowej wersji w rejestrze npm, updater aplikacji desktopowej (wydania open-mercato/cezar), pobieranie Node.js z nodejs.org przez aplikację desktopową, domyślne repozytorium skilli `open-mercato/skills`.

## Co usunięto

| Funkcja | Gdzie |
|---|---|
| Telemetria opt-in do `stats.openmercato.cloud`: zdarzenia użycia, raporty błędów, dzienny ping, pasek zgody, Settings → Privacy, `cezar telemetry`, identyfikator urządzenia `x-cezar-sid`, trasy `/api/v1/telemetry/*`, zmienne `CEZ_TELEMETRY*`, obsługa `DO_NOT_TRACK`, stemplowanie identyfikatora usługi w workflowach wydań | `packages/cezar`, `packages/contract`, `packages/web`, `.github/workflows` |
| Raporty błędów powłoki desktopowej (`telemetry.rs`, przycisk „Send error report”, hook awarii) | `packages/desktop` |
| Liczba gwiazdek z GitHuba (`GET /api/v1/star-count`, chip ⭐, okno prośby, linia w bannerze startowym) | serwer, kontrakt, cockpit |
| Automatyczne aktualizacje skilli Open Mercato (`npx skills` uruchamiane samo, `/api/v1/workspace/skills-update*`, przełącznik w Settings → Skills, `CEZ_SKILLS_AUTO_UPDATE`) | serwer, kontrakt, cockpit |
| Etykieta `surface` w body `POST /runs/:id/archive` i `/pin` (służyła tylko telemetrii) | serwer, cockpit |

Dodatkowo `packages/cezar/src/webhooks/transport.ts` nie przekazuje już `maxRedirections`: undici 6 ma domyślnie 0, a undici 7 usunął tę opcję. Przekierowania nadal nie są wykonywane; kod typuje się z obiema wersjami.

Lokalne „telemetry” w kodzie (próbki CPU/RAM maszyny, widget zużycia, Dashboard) to dane lokalne i zostały.

## Weryfikacja (na tej gałęzi)

- `tsc --noEmit`: serwer z testami, cockpit, kontrakt, api-client — bez błędów.
- Testy serwera: każde niepowodzenie występuje też na `0192afa4` albo przechodzi przy ponownym uruchomieniu (testy czasowe pod obciążeniem). Testy Codex 39/39, webhooki 551/551 (undici 6 i 7).
- Testy cockpitu (vitest) na linii 0.19 **nie zostały w całości uruchomione** — do zrobienia przy wdrożeniu.
- `npm run build` i `npm run test:package` nie były uruchamiane.

## Uruchamianie testów — ważne

Testy uruchomione z sesji agenta cezara dziedziczą jej zmienne `CEZ_*` (`CEZ_AGENT_MODELS_LOCKED=1`, `CEZ_API_URL` produkcyjnego cockpitu, `CEZ_PROJECT_ID`, `TMPDIR` pod `~/.cezar`). To one powodowały większość niepowodzeń (w próbie 57 zamiast 6). Uruchamiaj w czystym środowisku:

```bash
env -i HOME="$HOME" PATH="$PATH" TERM=dumb TMPDIR=/tmp USER="$USER" LANG=C.UTF-8 npm test -- packages/cezar
```

W worktree bez własnego `node_modules` pakiety `@open-mercato/*` rozwiązują się do kopii z głównego checkoutu, a `undici` do wersji 7 z roota. Do testów zainstaluj zależności (`npm ci`) w katalogu builda.

Niepowodzenia zależne od maszyny, nie od kodu: testy eskalacji SIGTERM→SIGKILL (`claude-cli-runner`, `junie-runner`, `process-signals`) i `provider-action-gating` dla Junie.

## Wdrożenie

Stan tej maszyny (WSL, sprawdzony 2026-11-18): usługa `cezar.service` (użytkownika) uruchamia `~/.local/bin/cezar-local`, a ten — `node ~/.local/share/skorowidny-cezar/releases/<sha>/node_modules/@open-mercato/cezar/dist/index.js --port 4322 --no-open`. Jedyny drop-in to `~/.config/systemd/user/cezar.service.d/codex-full-access.conf` z `CEZ_CODEX_FULL_ACCESS_PROJECTS=robocraftwars,skorowidny-cezar`. Plików `zz-codex-network.conf`, `90-skorowidny.conf` ani katalogu `maintenance/` tu nie ma.

1. W worktree na zatwierdzonym commicie: `npm ci`, `rm -rf packages/cezar/dist packages/cezar/web/dist`, `npm run build`. Czyszczenie `dist` jest konieczne: `tsc` nie usuwa plików po skasowanych źródłach (bez niego do paczki trafił stary `dist/telemetry.js`).
2. `npm pack -w @open-mercato/cezar --pack-destination <tmp>`.
3. `releases/<sha8>/`: tarball, `SOURCE_SHA`, `package.json` z zależnością `"@open-mercato/cezar": "file:open-mercato-cezar-0.19.0.tgz"`, potem `npm install --omit=dev`.
4. Smoke test: z katalogu z pustym repo, bez zmiennych `CEZ_*`, z `CEZ_HOME`/`HOME` w `/tmp` i `CEZ_DRY_RUN=1`, port inny niż 4322; `/api/v1/health`, `/` i `/api/v1/runs` muszą dać 200.
5. Przełączenie skryptem uruchomionym przez `systemd-run --user --on-active=60` (poza cgroupą usługi, bo restart kończy sesje agentów, także tę, która wdraża): podmiana ścieżki w `cezar-local`, `daemon-reload`, restart, health do 60 s, a bez 200 — samodzielne wycofanie. Wzór: `~/.local/share/skorowidny-cezar/switch-to-c454adf1.sh`. Wynik trafia do `deployments.log`.

Nie używaj okna aktualizacji w cockpicie: proponuje upstream `@open-mercato/cezar`.

## Wycofanie jedną komendą

```bash
~/.local/share/skorowidny-cezar/rollback-to-0192afa4.sh
```

Przywraca `cezar-local` i `codex-full-access.conf` z kopii `*.before-c454adf1` (wydanie `0192afa4`, Codex bez sandboxa tylko w `robocraftwars`), robi `daemon-reload` i restart, czeka na health i dopisuje wynik do `deployments.log`. Danych nie rusza.

## Pozostałości

Na tej maszynie w `releases/` są tylko `0192afa4` (do wycofania) i `c454adf1` (wdrożone). Katalogów `e7ce920c-*`, kopii `maintenance/pre-deploy-*` ani worktree `75ca1ad3`/`e392dc5d` tu nie ma.
