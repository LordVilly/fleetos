# Publicare automată pe cPanel

Deploy-ul în producție rulează din GitHub Actions după un push pe `main` și numai dacă jobul de validare PHP/JavaScript și testele de sincronizare trec.

## Pregătire unică în cPanel și GitHub

1. În cPanel → **FTP Accounts**, creează un cont FTPS separat, limitat la `/public_html` (rădăcina documentată pentru `lordvilly.ro`). Nu folosi contul principal cPanel.
2. În repository-ul `LordVilly/fleetos`, deschide **Settings → Secrets and variables → Actions → New repository secret** și salvează:
   - `CPANEL_FTP_SERVER` — hostname FTPS indicat de hosting;
   - `CPANEL_FTP_USERNAME` — utilizatorul contului FTPS;
   - `CPANEL_FTP_PASSWORD` — parola acelui cont.
3. Dacă directorul FTPS nu este rădăcina `/public_html`, adaugă variabila de repository `CPANEL_FTP_SERVER_DIR` cu calea relativă din rădăcina contului FTP și `/` final. Implicit este `./`.
4. Dacă hostingul cere alt port decât 21, adaugă `CPANEL_FTP_PORT` ca variabilă de repository. Conexiunea este FTPS explicită, cu verificarea certificatului activată.
5. Confirmă că ramura implicită a repository-ului este `main` și că PR-ul care conține schimbările a trecut validările înainte de merge.

## Comportament și protecția datelor

- Jobul de deploy este blocat în spatele jobului de validare și nu rulează pentru pull request-uri sau ramuri de lucru.
- `.env`, fișierele `.env.*`, `.git`, testele, uploadurile și backupurile sunt excluse din transfer.
- Acțiunea nu folosește opțiunea de curățare completă; păstrează fișierele de pe server care nu sunt gestionate de GitHub Actions.
- Fișierul `.ftp-deploy-sync-state.json` este intern și este blocat de Apache prin `.htaccess`.
- După merge pe `main`, verifică GitHub → **Actions → Validate FleetOS**. Deploy-ul trebuie să apară ca job reușit înainte de a verifica `https://lordvilly.ro`.
- Revenirea la o versiune anterioară se face printr-un revert Git pe `main`, urmat de aceleași validări și redeploy.
