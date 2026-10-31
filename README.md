# FleetOS — rulare locală și import cu GPT

Aplicația se deschide prin serverul local, nu direct din `index.html`, pentru ca funcțiile de server să poată folosi API-ul. Dacă aveți date salvate în versiunea deschisă cu `file://`, generați înainte de mutare un backup complet din **Setări → Backup și sincronizare**.

## Cerințe

- Node.js 20 sau mai nou
- O cheie API OpenAI cu acces la un model cu analiză de imagini

## Pornire în PowerShell

```powershell
$env:OPENAI_API_KEY = "cheia-ta-api"
npm start
```

Apoi deschideți `http://127.0.0.1:4173`. Pentru alt model, setați opțional `OPENAI_MODEL` înainte de `npm start`; implicit este `gpt-6-astra`.

Fără `OPENAI_API_KEY`, restul aplicației funcționează, iar butonul GPT afișează clar că integrarea nu este configurată. Cheia rămâne doar în mediul serverului și nu ajunge în browser.

## Documente tehnice și asistență GPT în fișa vehiculului

În secțiunea **Informații suplimentare** se pot atașa fișiere de orice tip; fișierele sunt stocate în IndexedDB pe dispozitivul/browserul folosit. În fereastra de diagnostic se pot încărca și imagini noi cu martorul ori codul de eroare; după o analiză reușită acestea se atașează fișei și se salvează în istoric. PDF-urile, imaginile PNG/JPEG/WEBP/GIF, fișierele text uzuale, Word, Excel, PowerPoint și ODT pot fi selectate explicit pentru a fi trimise la OpenAI într-o investigație. Formatele neacceptate de Responses API rămân disponibile pentru descărcare din fișă. Investigațiile și sursele lor sunt salvate în istoricul local al vehiculului; toate investigațiile GPT anterioare sunt retrimise ca context la următoarea analiză.

După importul unui vehicul prin **Adaugă cu GPT**, aplicația pornește o căutare web obligatorie. GPT propune manuale PDF/HTML de surse HTTPS citate; serverul acceptă descărcarea doar pentru surse marcate oficial cu încredere ridicată, citate de căutare, cu tipul real PDF/HTML și adresă IP publică. Documentul descărcat este atașat fișei locale. Datele pentru uleiuri, lichide și filtre se salvează automat ca repere numai când modelul le leagă de sursa oficială descărcată și le marchează cu încredere ridicată. Celelalte rămân propuneri de verificat. Dacă vehiculul are deja kilometri/ore, aplicația cere introducerea confirmată a ultimei înlocuiri înainte să activeze calculele scadenței. Nu poate garanta găsirea unui manual oficial sau potrivirea exactă când lipsesc varianta, motorul ori VIN-ul.

Pentru aceste funcții este necesară pornirea prin serverul local și configurarea OPENAI_API_KEY; cheia nu este inclusă în livrabil. Fișierele atașate unei investigații și întrebarea sunt trimise la OpenAI după apăsarea butonului de analiză.

## Importul vehiculului

Din Flotă apăsați **Adaugă cu GPT**, selectați fotografii clare ale certificatului, cărții tehnice, plăcuței sau contoarelor. GPT identifică tipul fiecărei surse, extrage câmpurile, apoi face o a doua analiză independentă a acelorași imagini. Vehiculul se creează numai dacă a doua verificare confirmă datele esențiale și încrederea nu este scăzută. Datele incerte sau contradictorii nu se înregistrează; imaginile trebuie reîncărcate mai clar. Fișa salvează tipurile de sursă și notele verificării; numărul intern FleetOS se generează local când documentele nu îl conțin.

Formatele acceptate: PNG, JPEG, WEBP și GIF. Limită: 8 fotografii, maximum 12 MB total. Fotografiile importului sunt ținute temporar în memorie pentru cererea API. La inițierea unei investigații GPT, datele vehiculului relevante și fișierele selectate sunt trimise la OpenAI pentru analiză. Datele FleetOS sunt păstrate în browser până la conectarea sincronizării și apoi în baza MySQL centrală; cheia API rămâne doar pe server.

## Documentație

Fluxul folosește Responses API cu imagini `input_image` în format data URL și Structured Outputs pentru schema de date. Consultați [OpenAI Images and vision](https://developers.openai.com/api/docs/guides/images-vision) și [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## Trimiterea cererilor de piese prin WhatsApp Business

Butonul **Trimite cererea către toți furnizorii** apelează direct endpoint-ul local și transmite câte un mesaj fiecărui destinatar introdus. Aplicația înregistrează separat răspunsul API pentru fiecare furnizor; starea „acceptată de WhatsApp” confirmă acceptarea API, nu livrarea sau citirea mesajului.

Pentru trimitere reală, deschideți aplicația prin serverul local (nu prin `file://`) și configurați pe server variabilele de mediu:

- `WHATSAPP_ACCESS_TOKEN` — token pentru WhatsApp Business Cloud API;
- `WHATSAPP_PHONE_NUMBER_ID` — ID-ul numărului expeditor înregistrat;
- `WHATSAPP_API_VERSION` — versiunea Graph API activă în aplicația Meta;
- opțional, `WHATSAPP_TEMPLATE_NAME` și `WHATSAPP_TEMPLATE_LANGUAGE` — șablon aprobat, cu un singur parametru text în corp pentru întregul mesaj FleetOS.

Dacă nu este configurat un șablon, API-ul încearcă trimiterea ca mesaj text; WhatsApp poate respinge mesajul când nu există o fereastră de conversație activă. Pentru solicitări inițiate de firmă în afara ferestrei permise, configurați un șablon aprobat și setați numele și limba acestuia. Păstrați tokenul numai în mediul serverului, niciodată în interfața HTML.

## cPanel, PHP și MySQL — starea actuală

Domeniul vizat este `https://villy.daserdesign.ro/`. Versiunea PHP adăugată include ecranul de autentificare, sesiunea cu protecție CSRF, API-ul pentru starea FleetOS și documente, sincronizarea PC–telefon și scriptul PHP de import al backupului.

**Această versiune nu este încă pregătită pentru utilizare completă pe cPanel.** Endpointurile de analiză GPT, documente tehnice și trimitere WhatsApp există momentan numai în `server.js` (Node.js); `api/index.php` nu le-a portat încă și răspunde cu HTTP 501. Pe hosting fără Node, aceste funcții nu vor funcționa până la portarea lor în PHP. PHP nu este disponibil în mediul de dezvoltare folosit pentru acest push, deci fișierele PHP nu au trecut `php -l` și nici o conectare reală la MySQL.

### Configurarea cPanel după finalizarea backendului PHP

1. Activează HTTPS pentru `villy.daserdesign.ro` și setează document root-ul domeniului către folderul `outputs` din repository.
2. În **MySQL Database Wizard**, creează baza și utilizatorul MySQL, apoi acordă utilizatorului drepturi asupra bazei.
3. În **phpMyAdmin**, selectează baza și importă `database/schema.sql`.
4. Copiază `.env.example` în `.env` în directorul aplicației și completează `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `FLEETOS_LOGIN_USER` și `FLEETOS_LOGIN_PASSWORD`. Numele bazei și utilizatorului includ de obicei prefixul contului cPanel.
5. Păstrează `.env` în afara accesului web. `.htaccess` blochează accesul direct, dar verifică protecția cu URL-ul `https://villy.daserdesign.ro/.env` înainte de a introduce parole reale. Folosește PHP cu extensiile PDO MySQL și cURL activate.
6. După portarea și testarea endpointurilor încă lipsă, conectează primul dispozitiv, autentifică-te și folosește **Setări → Sincronizare PC ↔ telefon → Trimite copia locală** pentru inițializarea bazei.

### Importul datelor existente

Înaintea migrării, generează **Setări → Backup și sincronizare → backup complet**. Backupul versiunea 2 include datele FleetOS și fișierele atașate din IndexedDB. Păstrează-l într-un director privat, în afara `public_html`. După instalarea PHP pe contul cPanel, comanda de import va fi:

```bash
php scripts/import-local-backup.php /home/CPANELUSER/fleetos-backup.json
```

Importul refuză implicit să suprascrie o bază care conține deja o flotă. `--replace` înlocuiește explicit datele și documentele existente; folosește-l numai după un backup separat.

### Funcții care trebuie portate înainte de utilizarea pe cPanel

- API-ul de analiză a fotografiilor vehiculului cu GPT;
- API-ul de investigare și căutare web pentru defecțiuni/manuale;
- descărcarea controlată a manualelor oficiale;
- trimiterea WhatsApp Business și configurarea sigură a tokenurilor în `.env`;
- testele de autentificare, migrare, sincronizare, documente și regresie în versiunea PHP.

Până la încheierea acestor pași, păstrează aplicația locală și backupurile. Nu considera sincronizarea cPanel sau funcțiile GPT/WhatsApp validate doar pentru că interfața se încarcă.
