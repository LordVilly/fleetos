# Transfer de date Agenda între servere

## Ce transferă arhiva

Agenda este o aplicație web/PWA cu backend PHP și MySQL/MariaDB. Datele sunt într-un model de snapshot:

- `fleetos_state`: snapshot-ul versionat al flotei, mentenanței, comenzilor, alertelor, istoricului și setărilor aplicației;
- `fleetos_documents`: metadatele și conținutul binar al documentelor atașate vehiculelor;
- `fleetos_migrations`: istoricul versiunilor și checksum-urile migrațiilor;
- orice alt tabel propriu aplicației cu prefixul `fleetos_`, inclusiv tabelele de backup dacă sunt prezente.

Arhiva ZIP conține `manifest.json`, câte un dump JSON Lines complet pentru fiecare tabel și fișierele atașate separat. Manifestul notează aplicația și amprenta build-ului HTML, versiunea schemei, data UTC, numărul rândurilor și dimensiunea/checksum-ul SHA-256 pentru fiecare dump și atașament. `.env`, parolele, tokenurile API, codul din alte proiecte și datele din tabele fără prefixul `fleetos_` sunt excluse. Atașamentele rămân legate de vehicul prin identificatorul lor.

Nu se creează altă bază de date: importul scrie în baza MySQL deja configurată în `.env` pe noul hosting.

## Cerințe hosting

- PHP 8.1+ cu PDO MySQL și extensia `ZipArchive` (`zip`).
- Tabele Agenda InnoDB migrate la aceeași versiune pe serverul sursă și cel țintă.
- Permisiune de creare a unui director privat lângă document root, în afara acestuia. Aplicația folosește `../.agenda-private` relativ la document root și setează permisiuni restrictive.
- Pentru importuri mari: valorile cPanel/PHP `upload_max_filesize`, `post_max_size`, `max_execution_time` și spațiul temporar trebuie să permită dimensiunea arhivei. Exportul folosește fișiere temporare pe disc și nu ține arhiva ZIP întreagă în memorie. Limitările PHP/MySQL ale hostingului continuă să se aplice.
- HTTPS activ.

Dacă extensia ZIP lipsește sau spațiul privat nu poate fi creat în afara web root, funcția refuză operația; arhiva nu este salvată într-un director public.

## Flux de migrare punctuală

1. Publicați aceeași versiune de cod pe ambele servere și faceți pull/deploy conform procedurii administratorului.
2. Înainte de import, confirmați că noul `.env` indică baza de date țintă și autentificarea Agenda funcționează.
3. Pe serverul vechi, autentificați-vă ca administrator și deschideți **Setări → Transfer complet de date → Descarcă arhiva completă**. Browserul descarcă un singur ZIP. Linkul temporar expiră în 15 minute și permite o singură descărcare.
4. Copiați ZIP-ul pe calculatorul folosit pentru administrare. Nu îl trimiteți public și nu îl păstrați în `public_html`.
5. Pe noul server, autentificați-vă, rulați **Setări → Migrare / actualizare bază de date**, apoi reîncărcați pagina Setări.
6. Alegeți **Alege arhivă ZIP și importă**. Aplicația verifică ZIP-ul, toate checksum-urile, schema și referințele documentelor fără să modifice baza.
7. Citiți rezumatul și confirmați în dialog numai dacă serverul țintă trebuie înlocuit. Înainte de scriere, aplicația creează un ZIP privat de backup al bazei țintă și afișează un link temporar pentru descărcarea lui.
8. La succes, ecranul raportează rândurile restaurate pentru fiecare tabel și numărul de atașamente. Verificați apoi vehiculele, istoricul, comenzile și documentele pe noul server și pe telefon.

Importul cere autentificare, CSRF și confirmare explicită; tokenurile de descărcare sunt aleatoare, expiră și sunt consumate la prima utilizare. Fișierul încărcat este păstrat temporar în director privat numai până la import/anulare/expirare. Fișierele expirate sunt curățate la următoarea cerere de transfer.

## Integritate, rollback și limite

- Importul respinge alt format, manifest incomplet, checksum greșit, cale de arhivă nepermisă, relație document–vehicul invalidă, tabele/coloane diferite și alt fingerprint al migrațiilor.
- Importul nu execută SQL furnizat de arhivă; inserează date în tabelele Agenda deja existente. Tabelele trebuie să fie InnoDB. Scrierea se face într-o tranzacție; o eroare înainte de commit revine la datele țintă anterioare.
- Înainte de înlocuire se arhivează privat starea țintă curentă. După succes, descărcați linkul de backup din Setări și păstrați-l în siguranță. Dacă este necesară revenirea, încărcați acel ZIP prin aceeași funcție de import.
- PHP-ul shared hosting poate limita dimensiunea upload-ului și durata cererilor. Pentru arhive care depășesc aceste limite, ridicați limitele în cPanel sau solicitați furnizorului o fereastră/CLI de migrare. Nu se declară finalizat un export/import dacă interfața nu confirmă succesul.
- Acest proces este o **migrare punctuală**, nu sincronizare continuă. Dacă ambele instalări rămân active, modificările făcute după export pe serverul vechi nu se transferă. Importul poate înlocui modificările mai noi de pe serverul țintă; opriți editarea pe ambele servere în timpul ferestrei de migrare și alegeți explicit copia care rămâne sursă.
- Nu rulați export/import real până când operatorul nu îl aprobă și nu verifică faptul că serverul țintă este cel corect.

## Structura arhivei

```text
manifest.json
database/fleetos_state.jsonl
database/fleetos_documents.jsonl
database/fleetos_migrations.jsonl
database/fleetos_*.jsonl
files/<sha256-document-id>.bin
```

Arhiva este logică (rânduri și atașamente) și se restaurează doar în schema Agenda deja creată; nu este un dump SQL destinat importului arbitrar în phpMyAdmin.

