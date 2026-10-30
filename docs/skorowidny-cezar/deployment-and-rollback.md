# Wdrożenie skorowidny-cezar i powrót do oryginału

Status: plan operacyjny; przełączenie usługi nie zostało jeszcze wykonane. Użytkownik zezwolił na zastąpienie działającego Cezara forkiem po zintegrowaniu i sprawdzeniu modułu Scrum. Przed wdrożeniem ten dokument należy uzupełnić o rzeczywiste SHA wydania, ścieżkę release i backupu oraz wyniki weryfikacji.

## Stan zachowywany przed zmianą

- Usługa użytkownika: `cezar.service`.
- Obecny program: globalny pakiet `cezar-run@0.17.0`, uruchamiany przez istniejący unit systemd.
- Istniejący katalog roboczy, port i konfiguracja dostępu pozostają parametrami instalacji.
- Należy zachować oryginalny unit i wszystkie istniejące drop-iny. Nowa konfiguracja nie zastępuje cudzych plików.

Kopia aktualnego unitu i drop-inów została wykonana lokalnie w katalogu utrzymania istniejącej instalacji; dokładne prywatne ścieżki są w handoffie zadania, nie w publicznym repozytorium. Pełny backup danych należy wykonać po zatrzymaniu zapisujących je procesów bezpośrednio przed przełączeniem, aby uniknąć niespójnego snapshotu.

## Plan wdrożenia

1. Zbudować i zweryfikować zintegrowany moduł na osobnym porcie i osobnym profilu danych. Sprawdzić tworzenie/edycję backlogu, zapis po restarcie, przejścia stanów i połączenie z runami zgodnie z zatwierdzonym zakresem.
2. Przygotować wydanie w osobnym katalogu oznaczonym SHA. Nie nadpisywać globalnego pakietu oryginału ani nie uruchamiać produkcji z przebudowywanego drzewa roboczego.
3. Zatrzymać usługę i zapisać spójny backup danych projektu oraz profilu użytkownika. Backup zawierający dane lub poświadczenia pozostaje lokalny, z ograniczonym dostępem; nie trafia do Git.
4. Dodać wyłącznie nowy drop-in `90-skorowidny.conf`, który czyści `ExecStart` i wskazuje sprawdzony plik wejściowy nowego wydania. Zachować dotychczasowy katalog roboczy, ograniczenia dostępu i istniejące drop-iny.
5. Wykonać `systemctl --user daemon-reload`, uruchomić usługę i sprawdzić health, ładowanie UI, widoczność istniejących projektów oraz zapis danych modułu Scrum.
6. Dopiero po weryfikacji oznaczyć wdrożenie jako udane. Zapisać SHA, ścieżki release i backupu oraz wyniki sprawdzeń w lokalnej notatce operacyjnej.

Nowe dane modułu powinny być odseparowane od istniejących danych Cezara. Nieodwracalna migracja danych wspólnych wymaga osobnego uzgodnienia i sprawdzonego powrotu. Wdrożenie nie powinno niejawnie przełączać własnej wersji na upstreamowy kanał autoaktualizacji.

## Powrót do oryginału

Poniższe polecenia dotyczą standardowej ścieżki drop-inów usługi użytkownika. Przed wykonaniem sprawdzić, że plik jest właśnie dodatkiem tego wdrożenia:

```bash
systemctl --user stop cezar.service
mv ~/.config/systemd/user/cezar.service.d/90-skorowidny.conf \
   ~/.config/systemd/user/cezar.service.d/90-skorowidny.conf.disabled
systemctl --user daemon-reload
systemctl --user start cezar.service
systemctl --user is-active cezar.service
```

Zmiana rozszerzenia wyłącza wyłącznie własny drop-in. Oryginalny `ExecStart` i wcześniejsze ustawienia znów obowiązują. Nie usuwa się nowego wydania ani danych Scrum, aby można było je później sprawdzić lub wyeksportować.

Sprawdzić rzeczywistą linię startową przez `systemctl --user show cezar.service -p ExecStart` oraz health na porcie instalacji. Jeśli wspólne dane zostały uszkodzone, najpierw zachować kopię bieżącego stanu, a dopiero potem świadomie odtworzyć właściwy snapshot przy zatrzymanej usłudze. Odtworzenie snapshotu cofa także zmiany danych wykonane po jego utworzeniu; nie jest automatycznym krokiem zwykłego rollbacku programu.

Nie uznajemy samego `active` za dowód przywrócenia funkcjonalności: trzeba sprawdzić panel i dostęp do projektów.
