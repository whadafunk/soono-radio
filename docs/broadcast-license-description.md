# Descriere tehnică — sistem de automatizare radio (pentru licență de emisie)

**Sistemul asigură:**

•⁠ ⁠programarea și redarea automată a conținutului, pe baza unor grile orare (clock-uri) configurabile, fără intervenție manuală;
•⁠ ⁠gestionarea playlisturilor de muzică, reclame, jingle-uri, promo-uri, fundal muzical și înregistrări, cu selecție statică (ordine fixă) sau dinamică (pe reguli și rotații);
•⁠ ⁠inserarea automată a jingle-urilor și a elementelor de identificare a postului (station ID), precum și a segmentelor de deschidere/închidere a emisiunilor;
•⁠ ⁠gestionarea reclamelor prin campanii publicitare, cu control al frecvenței și duratei de difuzare pentru fiecare campanie;
•⁠ ⁠programarea emisiunilor și a segmentelor de program, inclusiv excepții și suprapuneri pentru zile speciale sau evenimente;
•⁠ ⁠gestionarea materialelor audio — încărcare, catalogare și difuzare a conținutului pregătit sau înregistrat;
•⁠ ⁠continuitatea transmisiei, prin mecanisme de rezervă (surse/playlisturi de siguranță), monitorizare permanentă a fluxului și corectare automată a abaterilor față de programul planificat, astfel încât emisia să nu se întrerupă.

**Descrierea soluției tehnice utilizate:**

Sistemul este compus dintr-un motor de automatizare audio bazat pe LiquidSoap, care generează și redă fluxul audio conform programării definite, și un server de streaming Icecast, care distribuie semnalul către ascultători. Un modul software de control (backend Node.js și interfață web) permite operatorului să configureze grilele de programare, playlisturile, campaniile publicitare și biblioteca de conținut. Un modul de supervizare monitorizează în timp real execuția programului, corectează automat abaterile față de planificare și asigură continuitatea difuzării prin mecanisme de rezervă în cazul lipsei sau erorii de conținut.
