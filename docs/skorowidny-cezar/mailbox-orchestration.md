# Mailbox orchestration — architektura do wbudowania w cezar (projekt)

Autor: Skorowid. Źródło: pętla katalogu RobocraftWars 2026-11-14/15 (root 4051eb5b), opis właściciela: „jeden proces główny
budujący (pilnujący I/O, posiadający nadzorców Claude), nadzorcy zlecają zadania Codexowi i Claude'owi w stosunku 60/40, a czasem
obu to samo i zbierają lepsze; oddzielny proces jest ownerem gałęzi i pushuje zmiany, które przyjmuje w skrzynkach; wszystko
wymieniane w skrzynkach jak pocztą”. Dziś działa jako skill (`ai-env-configs-tools/skills/mailbox-orchestration/SKILL.md`)
i skrypty projektu. Ten dokument: co cezar ma, czego brakuje, propozycja wbudowania. Status: PROPOZYCJA do decyzji właściciela.

## Co cezar ma już dziś

Dispatch (`cez task create`, 4 dzieci w locie), skrzynki `.ai/cezar/dispatch/<root>/inbox/<id8>/` budzące adresata, raporty
(`cez task report`), Guard (`CEZ:ASK`), handoff, runner/model na zadanie, `queueWaitReason` (np. `account-resume`).

## Czego brakuje (i co dało największy zysk ręcznie)

| # | mechanizm | dziś (ręcznie) | proponowane w cezarze |
|---|---|---|---|
| 1 | **Strażnik I/O** | root i nadzorcy czytają `/proc/pressure/io` przed dispatchem; skala dzieci 4/3/2/1/0 wg avg60 | engine odkłada start dziecka z `queueWaitReason: io-pressure`, gdy avg60 > próg; próg z `CEZ_IO_LIMIT` (domyślnie 80 na Linuksie z PSI, brak PSI = wyłączone); start dzieci rozłożony w czasie (worktree add jest najdroższy) |
| 2 | **Role w drzewie** | konwencja w zleceniach (root / nadzorca / wykonawca / recenzent) | `--role builder|supervisor|executor|reviewer` w `cez task create`; prompt roli dokleja engine; widok drzewa grupuje po rolach |
| 3 | **Mieszanie wykonawców** | nadzorca ręcznie 60% Codex / 40% Claude; „oba to samo” dla ważnych | `--runner mix` (proporcja z ustawień drzewa, domyślnie 60/40) i `--dual` (dwa przebiegi tego samego zlecenia, raport porównawczy, rodzic wybiera gałąź do scalenia) |
| 4 | **Właściciel gałęzi** | osobne zadanie (8618f165) przyjmuje partie z inbox, scala origin/main, testuje, pushuje, wdraża | rejestr „owner gałęzi” w projekcie; `cez task release --batch <commit> --note …` wysyła do inbox ownera; tylko owner może `push` gałęzi chronionej; blokada równoległych wydań (było nadpisanie dwóch uploadów) |
| 5 | **Poczta** | pliki markdown z konwencją (temat, fakty, repro, prośba) | `cez mail send <id8|root|owner:<branch>> --subject … --file …`, wątki, odczyt w kokpicie, odpowiedź do nadawcy; między drzewami (`owner:` innego drzewa) |
| 6 | **Rezerwacja kolejki** | plik kolejki w repo + listy `<sup>-units.txt` | opcjonalny „queue” drzewa: elementy, status, rezerwacja na zadanie, zwrot nierozpoczętych przy zakończeniu |
| 7 | **Sieroty** | root szuka raportów `done` dzieci zmarłego nadzorcy i scala je | raport dziecka, którego rodzic zakończył się (failed/limit), idzie do dziadka z flagą `orphan` |
| 8 | **Limity kont** | ręczne anulowanie i ponowny dispatch na innym runnerze + lista gałęzi częściowych | przy `account-resume`/`usageLimitExceeded` engine proponuje (lub wg ustawienia wykonuje) przeniesienie zadania na inny runner, z gałęzią poprzednika do kontynuacji |
| 9 | **Lżejsze worktree** | brak (pełny checkout ~4 GB pack) | opcjonalny sparse-checkout z pliku `.ai/cezar/sparse` (wzorce do pominięcia, np. duże PNG/GLB), `worktree add --no-checkout` + `sparse-checkout set` |
| 10 | **shortstat kokpitu** | `.gitattributes` binary w projekcie, przesunięty `main` | jeden `git diff --shortstat` naraz na worktree (single-flight) i baza = gałąź rodzica, nie stary base branch |
| 11 | **Scratch w RAM** | pilotaż: tmpfs `/mnt/cezar-scratch` (`vm/tmpfs-setup.sh`, `vm/scratch-env.sh` w ai-env-configs-tools) jako TMPDIR dla 1/4 procesów (2026-11-15) | `CEZ_SCRATCH_SHM` — część zadań (proporcja) dostaje TMPDIR w `/dev/shm` z limitem; sprzątanie przy zakończeniu |

## Zasady przy wdrażaniu (z AGENTS.md cezara)

- Zero config: każdy mechanizm odkrywany albo z bezpiecznym domyślnym; poszerzenia kosztu/ekspozycji za flagą `CEZ_*`
  (aktualizacja `.env.example` i `docs/reference.md`).
- Strażnik I/O i single-flight shortstat są czysto ograniczające — mogą być domyślnie włączone; `--runner mix`, `--dual`,
  automatyczne przenoszenie runnera i scratch w RAM — opt-in.

## Kolejność (propozycja)

1. Strażnik I/O + rozłożony start dzieci + single-flight shortstat (największy zysk stabilności kokpitu).
2. Sieroty do dziadka + przenoszenie przy limitach kont.
3. Role, `--runner mix`, `--dual`.
4. Owner gałęzi + `cez task release` + blokada równoległych wydań; `cez mail`.
5. Kolejka drzewa; sparse worktree; scratch w RAM.

## Przeładowanie kokpitu

Upgrade wymaga restartu usługi cezar (wszystkie sesje). Robić w oknie, gdy pętle projektów są zatrzymane (zadania zapisują
stan w handoff i commitach; po restarcie wznawiane). Właściciel decyduje o terminie.

Zobacz też: `ai-env-configs-tools/docs/vm-io-acceleration.md` (przyspieszenie I/O VM: tmpfs, kolejka ciężkich zadań na PC,
OneDrive jako archiwum).
