# FleetOS — instalare PHP pe cPanel

FleetOS este o aplicație web/PWA. Interfața rulează în browser, iar backendul este PHP 8.1+ cu MySQL. Nu este necesar Node.js pe calculator sau pe hosting. PC-ul și telefonul folosesc aceleași date centrale când sincronizarea este activată.

## Cerințe pe cPanel

- PHP 8.1 sau mai nou (recomandat: 8.3+); activați `PDO MySQL`, `cURL`, `OpenSSL`, `JSON` și `mbstring` în **Select PHP Version**.
- Apache cu `mod_rewrite` și `.htaccess` permis.
- MySQL/MariaDB și HTTPS pentru `villy.daserdesign.ro`.
- Pentru funcțiile GPT și WhatsApp, conturi/API-uri configurate separat și acces HTTPS de ieșire permis de hosting.

## Instalare

1. Creați baza de date și utilizatorul în **cPanel → MySQL Database Wizard**; acordați utilizatorului toate privilegiile asupra bazei.
2. În phpMyAdmin, selectați baza și importați `database/schema.sql`.
3. Faceți pull al branch-ului `main` în directorul document root al domeniului (`public_html` sau document root-ul `villy.daserdesign.ro`). Fișierele proiectului trebuie să fie direct în document root, astfel încât `index.html` să se deschidă la `/`.
4. Copiați `.env.example` ca `.env` în același director și înlocuiți valorile exemplu cu datele bazei, utilizatorul și o parolă unică lungă pentru FleetOS. Numele MySQL cPanel au de obicei prefixul contului. Nu încărcați `.env` în GitHub.
5. Opțional, completați cheia OpenAI și datele WhatsApp Business Cloud. Nu activați funcțiile respective până când integrarea nu este configurată. `WHATSAPP_API_VERSION` trebuie să fie versiunea Graph API activă pentru aplicația Meta.
6. Deschideți `https://villy.daserdesign.ro`. Verificați autentificarea și apoi **Setări → Sincronizare PC ↔ telefon → Testează conexiunea**. Pentru prima migrare, importați datele local înainte de a porni sincronizarea; consultați secțiunea următoare.

`.env` este blocat de `.htaccess`. Înainte de a scrie parole reale, confirmați că `https://villy.daserdesign.ro/.env` nu afișează conținut. Păstrați HTTPS activ permanent.

## Migrarea datelor locale

1. În versiunea curentă, generați **Setări → Backup și sincronizare → backup complet** și păstrați fișierul într-un loc privat.
2. Puneți backupul temporar într-o cale privată pe contul cPanel, în afara document root-ului.
3. Dacă furnizorul oferă PHP CLI/SSH, rulați din directorul aplicației:

```bash
php scripts/import-local-backup.php /home/CPANELUSER/fleetos-backup.json
```

Importul se oprește fără modificări dacă baza are deja date. Opțiunea `--replace` suprascrie explicit starea și documentele serverului și trebuie folosită numai după un backup separat. Dacă nu aveți SSH/PHP CLI, configurați mai întâi aplicația și folosiți opțiunea **Trimite copia locală** doar când baza este goală și ați verificat backupul. Nu selectați sincronizarea de pe server înainte de import, deoarece va înlocui datele locale.

## `.env.example`

- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`: conexiune PDO MySQL.
- `FLEETOS_LOGIN_USER`, `FLEETOS_LOGIN_PASSWORD`: autentificarea aplicației. Folosiți o parolă puternică și unică.
- `OPENAI_API_KEY`, `OPENAI_MODEL`: citire documente, investigații și căutare web GPT.
- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION`: WhatsApp Business Cloud API.
- `WHATSAPP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANGUAGE`: opțional, șablon WhatsApp aprobat.

Pentru mesajele inițiate de firmă, WhatsApp poate cere un șablon aprobat. FleetOS raportează trimiterea ca reușită numai după ce API-ul WhatsApp returnează ID-ul mesajului; acceptarea API nu garantează livrarea sau citirea.

## Rulare locală fără Node.js

Este necesar PHP 8.1+ (recomandat: 8.3+) cu PDO MySQL și cURL. Copiați `.env.example` în `.env`, completați configurația, apoi porniți din acest director:

```bash
php -S 127.0.0.1:4173 router.php
```

Deschideți `http://127.0.0.1:4173`. Pentru testarea pe telefon, folosiți un host HTTPS; service worker-ul PWA nu funcționează pe un IP local obișnuit fără HTTPS.

## Date și backupuri

Datele flotei sunt salvate ca snapshot JSON versionat în MySQL, iar fișierele atașate separat ca BLOB. Sincronizarea oprește salvarea la conflict de versiune, pentru a nu suprascrie tacit modificările altui dispozitiv. Datele offline rămân în localStorage/IndexedDB până la sincronizare. Faceți backup atât din FleetOS, cât și prin instrumentele cPanel înainte de migrări sau actualizări.

PWA poate păstra interfața cache-uită offline, dar autentificarea, MySQL, GPT, căutarea web și WhatsApp necesită conexiune. Ștergerea datelor browserului poate elimina copii locale nesincronizate.

## Verificări după publicare

- Login, logout și protecția paginii/API-ului.
- `https://villy.daserdesign.ro/api/health` după autentificare și conexiunea MySQL.
- Sincronizare inițială, apoi modificare și sincronizare pe al doilea dispozitiv.
- Atașare, descărcare și ștergere document; backup complet și restaurare într-o bază de test.
- Test GPT cu o imagine de identificare și o investigație web cu un document atașat.
- Test WhatsApp numai către un destinatar autorizat, cu mesaj/șablon test.
- Instalare PWA din browser și actualizare controlată.

Interfața, sincronizarea și API-urile PHP sunt pregătite pentru hosting PHP; integrarea efectivă cu MySQL/OpenAI/WhatsApp trebuie validată pe contul cPanel, deoarece depinde de extensiile, credențialele și politicile acelui hosting.
