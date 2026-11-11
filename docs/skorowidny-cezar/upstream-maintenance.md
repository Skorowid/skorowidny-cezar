# Przejmowanie zmian z upstreamu

## Zasada

`origin` wskazuje `Skorowid/skorowidny-cezar`, `upstream` wskazuje `open-mercato/cezar`. Domyślna gałąź robocza forka to `skorowidny/main` — zawiera własne przyrosty. Odziedziczony `main` pozostaje snapshotem oryginału z chwili utworzenia forka i nie jest celem własnych PR. Dzięki temu nie trzeba nadpisywać historii nowszego upstreamu podczas pierwszej publikacji. Gałąź `upstream-main` w publicznym forku jest lustrzaną kopią ostatnio rozpatrzonego commita oryginału; nie dodajemy tam własnych commitów.

`fork/upstream.json` identyfikuje ostatnią w pełni zintegrowaną bazę upstream. Od 2026-11-03 jest nią zweryfikowany tag wydania `v0.18.0` (`0d801132ecc4a628e650c4cc1b5072e5d256ff15`). Porównania: `--upstream-ref upstream/main` pokazuje dalszy postęp upstreamu, a nowe wydanie weryfikuje się przez `gh release view <tag> -R open-mercato/cezar` i `git ls-remote --tags upstream`, bez zgadywania tagu. Nie zmieniamy historii oryginału ani nazw pakietów w pierwszym przyroście.

## Klonowanie i raport

```bash
git clone https://github.com/Skorowid/skorowidny-cezar.git
cd skorowidny-cezar
git remote add upstream https://github.com/open-mercato/cezar.git
gh repo set-default Skorowid/skorowidny-cezar
git fetch upstream --tags
python3 fork/tools/upstream_report.py --upstream-ref upstream/main --output /tmp/cezar-upstream-report.md
```

Docelowy plik musi nie istnieć, aby przypadkowo nie nadpisać poprzedniego raportu. Można użyć innej nazwy. `--format json` daje dane maszynowe; `--stdout` jawnie włącza drukowanie zamiast zapisu pliku. Narzędzie nie robi fetch, merge, checkout ani push. Bez fetch raport dotyczy lokalnie znanego refa, którego SHA zostaje podane w raporcie.

Jawny default `gh` kieruje zgłoszenia i PR do forka, zamiast polegać na automatycznym wyborze rodzica sieci forków. PR własnych zmian kierujemy do `skorowidny/main` w tym repozytorium; przekazanie poprawki oryginałowi jest osobną czynnością.

Raport pokazuje commity i zmienione ścieżki od zapisanej bazy do wskazanego upstreamu oraz do forka. Rozdziela backend, prezentację, kontrakty, dodatki forka i współdzieloną infrastrukturę. Wskazuje nakładające się ścieżki. Brak takiego nakładania nie dowodzi zgodności: zmiana kontraktu może oddziaływać na UI bez zmiany tego samego pliku. Raport nie jest symulacją merge ani automatyczną rekomendacją przyjęcia zmiany.

Podstawowe porównania:

```bash
git log --oneline HEAD..upstream/main
git diff upstream/main...HEAD -- packages/cezar packages/contract packages/api-client
git diff upstream/main...HEAD -- packages/web packages/desktop
git diff upstream/main...HEAD -- fork docs/skorowidny-cezar
```

Trzy kropki pokazują zmiany danej strony od wspólnego przodka, nie pełną różnicę drzew. Dla dokładnego porównania zawartości używamy `git diff upstream/main HEAD -- <ścieżki>`.

## Pełna aktualizacja na gałęzi roboczej

1. Zacząć z czystego drzewa, aktualnego `skorowidny/main` forka i świeżego fetch upstreamu. Utworzyć `maintenance/upstream-YYYY-MM-DD`.
2. Wygenerować raport i przeczytać opis wydania, commity oraz wymagania migracji.
3. Wykonać `git merge --no-ff --no-commit upstream/main` na gałęzi maintenance. W razie konfliktów rozwiązać je jawnie; można wycofać niezatwierdzoną integrację przez `git merge --abort`.
4. Nie stosować zbiorczego `--ours` ani `--theirs` dla UI. Zachować własny wygląd, ale uwzględnić wymagane zmiany kontraktów i zachowania. Backendowe testy mogą nie wykryć nieaktualnego klienta.
5. Uruchomić bramki jakości, testy własnych dodatków i istotne testy integracyjne/UI. Zapisać faktyczne wyniki.
6. Po pełnej integracji wpisać SHA zintegrowanego upstreamu do `baseline_commit` oraz zaktualizować wersję i datę w `fork/upstream.json`. Nie przesuwać bazy do commita, którego zmian w całości nie przyjęto.
7. Zapisać integrację, opisać konflikty i otworzyć PR do `skorowidny/main` forka. Aktualizacja lustrzanej gałęzi `upstream-main` może być tylko fast-forward do sprawdzonego upstreamu.
8. Scalenie, push i wdrożenie wykonuje osoba lub proces z odpowiednim upoważnieniem. Publikacja repozytorium nie ustanawia ogólnej zgody na przyszłe wdrożenia.

Ta procedura jest instrukcją na żądanie. Nie instaluje automatyzacji, harmonogramu ani procesu samodzielnie aktualizującego produkcję.

## Wybrana poprawka backendu

Gdy pełna aktualizacja jest przedwczesna, można rozpatrzyć `git cherry-pick -x <sha>` na osobnej gałęzi. Najpierw sprawdzamy zależne commity, zmiany kontraktów, lockfile, migracje i zachowanie klienta. Nie przejmujemy tylko jednego pliku z większej poprawki bez sprawdzenia całości.

`-x` zachowuje odnośnik do oryginalnego commita. W rejestrze zmian zapisujemy źródłowe SHA, testy i ewentualne adaptacje. Selektywny backport **nie przesuwa** `baseline_commit`: kolejne porównanie nadal powinno wykazać niezintegrowaną resztę upstreamu. Przy późniejszym pełnym merge sprawdzamy ewentualne powtórzenie lub konflikt poprawki.

## Jak rozwijać własny UI

- Zmiany wyglądu utrzymywać w osobnych commitach i małych modułach pod `packages/web/`, zgodnie z istniejącą architekturą React i Tailwind.
- Nie przenosić reguł biznesowych do komponentów i nie duplikować serwera. Interfejs korzysta z `packages/api-client` i schematów `packages/contract`.
- Preferować istniejące mechanizmy brandingu i motywu przed zmianą współdzielonego kodu. Przy nowej funkcji oddzielić zmianę kontraktu od wizualnego dopracowania.
- Nie zmieniać masowo nazw pakietów lub formatowania upstreamowych plików dla samego rebrandingu; utrudnia to późniejszą inspekcję poprawek.
- Przy pracy nad ekranem sprawdzać wymagane zachowania i dostępność, nie tylko wygląd. Własny UI nadal musi poprawnie obsługiwać API po aktualizacji backendu.

## Updater i wydawanie pakietów

Odziedziczony updater, linki do wydań i nazwy npm nadal wskazują oryginalnego Cezara. Nie jest to kanał dystrybucji forka. Przed wdrożeniem własnej aplikacji trzeba jawnie zaprojektować oddzielne wydania, nazwy pakietów i źródło aktualizacji; inaczej aktualizator mógłby zastąpić własną wersję upstreamem.

Fork nie instaluje się globalnie. Odziedziczone workflow publikujące upstreamowe pakiety pozostają w historii, ale GitHub Actions w świeżym forku utrzymujemy wyłączone do osobnej konfiguracji. Nie dodajemy tokenów npm ani sekretów wydań upstreamu.

Plik `.github/workflows/skorowidny-foundation.yml` opisuje tylko testy własnych przykładów i narzędzi. Jego obecność nie oznacza, że Actions zostały włączone. Przed przyszłym włączeniem Actions należy najpierw przejrzeć i ograniczyć odziedziczone workflow release/publish. Lokalna walidacja pozostaje dostępna bez usług CI.

## Lokalne bramki

```bash
npm ci
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
python3 -m unittest discover -s fork/tools -p 'test_*.py' -v
```

Długie polecenia uruchamiać z odpowiednim `timeout` i zapisem logów. Nie uznawać pominiętego lub przerwanego testu za sukces. Nowe błędy w niezmienionym upstreamie zapisać osobno, zamiast zmieniać cudzy core w ramach przygotowania przykładów.
