# Przyspieszenie I/O VM cezara (pomysły i zalecenia)

Autor: Skorowid. Kontekst: RobocraftWars 2026-11-14/15 — przy 4–12 zadaniach naraz presja I/O VM (`/proc/pressure/io`, avg60)
dochodziła do 85–92%, polecenia `git`/`node` przekraczały 2 min, cockpit zamarzał. CPU i RAM (46 GB) były wolne — wąskie gardło
to wirtualny dysk VM. Status: propozycje, nie wdrożone (poza oznaczonymi).

## Co najbardziej obciąża dysk (zmierzone)

| źródło | dlaczego | stan |
|---|---|---|
| `git worktree add` dla każdego nowego zadania | pełny checkout repo (tysiące GLB/PNG, ~4 GB pack) | otwarte |
| `git diff --shortstat <stara baza>` kokpitu, nakładające się wywołania | czytał całe binaria; baza `cef6e894` sprzed 1700 commitów | `.gitattributes` binary (741802b4) i przesunięty `main` — wdrożone |
| testy ładujące wszystkie paczki/biblioteki na starcie | ~250 paczek i ~460 GLB przy każdym teście jednej jednostki | `EXAMPLES_ONLY`, `openScript({parts})` — wdrożone |
| zrzuty diagnostyczne w commitach | 15 MB JSON na jednostkę | strażnik > 3 MB w merge — wdrożone |

## Na VM (bez komputera właściciela)

1. **tmpfs na scratch i buildy** (RAM wolny ~30 GB): `$TMPDIR` zadań, `test-build/`, staging wydań, wyniki testów w `tmpfs`
   (np. `mount -t tmpfs -o size=8G tmpfs /home/skorowid/.cezar/tmp`). Zysk: zapisy tymczasowe nie dotykają dysku.
2. **Lżejsze worktree**: sparse-checkout bez `docs/art/sheets/**`, `docs/pipeline/jobs/*/assembly/**`, `*.blend` dla zadań,
   które ich nie potrzebują; albo partial clone / Git LFS dla dużych binariów (pobierane na żądanie). Wymaga zmiany w kokpicie
   cezara (hook po `worktree add`) — zgłosić twórcom cezara.
3. **Kokpit**: jeden `shortstat` naraz na worktree (single-flight), baza = gałąź rodzica, nie stary `main` — zgłoszenie do cezara.
4. **Rozkładanie startów**: dispatch po jednym zadaniu, następne dopiero gdy `avg60` spadnie (worktree add jest najdroższy).
5. **Mount i dysk**: `noatime` dla partycji z repo; scheduler `none`/`mq-deadline` dla dysku virtio; `git gc` / `git maintenance`
   tylko w oknie niskiego I/O (213 MB śmieci, 9 packów w RobocraftWars); po zakończonych zadaniach `cargo clean` i usuwanie
   ich worktree.
6. **Hiperwizor** (do sprawdzenia przez właściciela — gdzie działa VM?): virtio-scsi/virtio-blk z `cache=none,io=native`,
   obraz raw lub prealokowany qcow2, dysk VM na NVMe zamiast HDD/RAID na wolnych dyskach. Osobny wirtualny dysk na NVMe tylko na
   `.ai/cezar/worktrees` i `target/` dałby największy skok.

## Z komputerem właściciela (PC 192.168.1.10, Ryzen 9 5950X, NVMe, tunel SSH jak dla Blendera)

7. **Kolejka zadań ciężkich na PC** — jak `blender_queue_server.py`: serwis na PC (Windows albo WSL2 na NVMe) z własnym klonem
   repo; VM wysyła `commit + polecenie` (test jednostki, build edytora, `cargo test`, reeksport paczek), PC robi
   `git fetch`/checkout, uruchamia i odsyła wynik + artefakty (tarball). Zysk: najcięższe I/O i CPU idą na NVMe PC; VM tylko
   koordynuje. Wymaga: klon z dostępem do GitHuba albo `git bundle` przesyłany tunelem; Node 24 i Rust na PC (albo WSL2).
8. **Build edytora na PC**: `rebuild-test.py --canonical-editor` w WSL2 na PC, archiwum wraca tunelem do VM, upload na hosting
   jak dotąd — build (~2000 plików) przestaje obciążać VM.
9. **Udział sieciowy z NVMe PC (SMB/NFS) dla artefaktów** — renderów, plansz, paczek do przeglądu, logów. NIE dla `.git` i
   worktree (git na udziale sieciowym jest wolny i ryzykowny przy wielu małych plikach). Przy 1 GbE (~110 MB/s) i tak szybsze
   niż nasycony dysk VM dla dużych plików sekwencyjnych.

## OneDrive

10. **Tylko archiwum, nie praca bieżąca**: `rclone` (rclone copy/sync z ograniczeniem `--bwlimit`) do przenoszenia gotowych
    renderów, plansz SDXL, raportów i zrzutów z repo/VM do OneDrive; w repo zostaje lekki indeks (ścieżka + SHA-256). Zysk:
    mniejsze repo → szybsze worktree add i shortstat; mniej danych na dysku VM. Nie trzymać repo git ani aktywnych worktree na
    OneDrive (synchronizacja psuje `.git`, konflikty plików, opóźnienia).
11. Kopie zapasowe gałęzi (`git bundle`) na OneDrive zamiast pełnych kopii repo na VM (`RobocraftWars-rebuild-backup-*`).

## Kolejność wdrażania (propozycja)

1. tmpfs na scratch (pkt 1) — minuty, bez ryzyka.
2. Sprawdzenie hiperwizora i dysku VM (pkt 6) — może dać najwięcej.
3. Kolejka ciężkich zadań na PC (pkt 7–8) — największy zysk przy dużych pętlach, kilka godzin pracy.
4. Lżejsze worktree i single-flight shortstat (pkt 2–3) — zgłoszenia do cezara.
5. Archiwum artefaktów na OneDrive (pkt 10).

## Pytania do właściciela

- Gdzie działa VM (host, typ dysku, format obrazu)? Czy można dodać jej drugi dysk na NVMe?
- Czy na PC jest/może być WSL2 z Node 24 i Rustem (kolejka ciężkich zadań)?
- Czy OneDrive ma być archiwum artefaktów (rclone z VM) i z jakim limitem miejsca?
