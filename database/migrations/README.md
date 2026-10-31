# Migrații FleetOS

Adăugați câte un fișier SQL nou pentru fiecare schimbare de schemă, cu nume sortabil, de exemplu `0002_vehicle_metadata.sql`. Utilizatorul apasă apoi **Setări → Migrare / actualizare bază de date**.

- Nu modificați `database/schema.sql` sau migrațiile deja aplicate; fiecare fișier aplicat este verificat prin SHA-256.
- Folosiți instrucțiuni SQL aditive și idempotente (`CREATE TABLE IF NOT EXISTS`, verificări înainte de `ALTER TABLE` unde este cazul). DDL-ul MySQL poate face commit implicit.
- Nu puneți date secrete în migrații. Folderul nu este accesibil direct prin web.
- Modificarea fișierelor aplicației necesită în continuare deployment-ul versiunii noi în cPanel; butonul execută doar migrațiile bazei din versiunea instalată.
