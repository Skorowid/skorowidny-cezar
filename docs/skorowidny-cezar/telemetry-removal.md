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

## Wdrożenie (dla drugiego cezara)

Procedura z `~/ai-projects/.ai/cezar/maintenance/fork-deployment-and-rollback.md`: build w czystym katalogu (`npm ci`, `npm run build`, potem ręcznie `node packages/cezar/scripts/inline-contract.mjs` — `ignore-scripts=true` pomija `postbuild`), `npm pack -w @open-mercato/cezar`, instalacja do `~/.local/share/skorowidny-cezar/releases/<sha>/`, smoke test na innym porcie z piaskownicą `CEZ_HOME`, przełączenie przez jednostkę `systemd-run --user`.

- `ExecStart`, który wygrywa, jest w `~/.config/systemd/user/cezar.service.d/zz-codex-network.conf`, nie w `90-skorowidny.conf`.
- Polityka Codex jest w źródle (`codexExecutionPolicy`); ręczna łatka `-codexnet` nie jest już potrzebna. `CEZ_CODEX_FULL_ACCESS_PROJECTS` (wpis 2026-11-18 w `changes.md`) trzeba ustawić w drop-inie, jeśli RobocraftWars ma działać bez sandboxa.
- Restart kończy sesje agentów. 4 zadania w RobocraftWars dostały 2026-11-18 polecenie zatwierdzenia pracy i zakończenia tury.
- Nie używaj okna aktualizacji w cockpicie: proponuje upstream `@open-mercato/cezar`.

## Wycofanie jedną komendą

```bash
~/.local/share/skorowidny-cezar/rollback-to-0192afa4.sh
```

Skrypt przepisuje tylko `zz-codex-network.conf` na wydanie `0192afa4-codexnet2` (poprzednią wersję zostawia jako `zz-codex-network.conf.before-rollback`), restartuje usługę, sprawdza health 200 i `ExecStart`, a wynik dopisuje do `deployments.log`. Danych nie rusza.

## Pozostałości po 0.20

- Katalogi wydań `releases/e7ce920c-codexnet` i `releases/e7ce920c-codexnet2` oraz kopia `maintenance/pre-deploy-e7ce920c-*` nadal są na dysku (nieużywane). Nie usunięto ich bez decyzji właściciela.
- Worktree zadań `75ca1ad3` i `e392dc5d` (gałęzie `cez/75ca1ad3`, `cez/e392dc5d`) zawierają wersję tych zmian na 0.20; cezar usunie je sam według retencji.
