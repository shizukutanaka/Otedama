# Otedama - Οδηγός Χρήσης Λογισμικού P2P Mining Pool

## Περιεχόμενα
1. [Εγκατάσταση](#εγκατάσταση)
2. [Διαμόρφωση](#διαμόρφωση)
3. [Εκτέλεση Otedama](#εκτέλεση-otedama)
4. [Λειτουργίες Εξόρυξης](#λειτουργίες-εξόρυξης)
5. [Διαχείριση Pool](#διαχείριση-pool)
6. [Παρακολούθηση](#παρακολούθηση)
7. [Αντιμετώπιση Προβλημάτων](#αντιμετώπιση-προβλημάτων)

## Εγκατάσταση

### Απαιτήσεις Συστήματος
- Λειτουργικό Σύστημα: Linux, Windows, macOS
- RAM: Ελάχιστο 4GB, Συνιστώμενο 8GB+
- Αποθήκευση: 50GB+ ελεύθερος χώρος
- Δίκτυο: Σταθερή σύνδεση internet

### Γρήγορη Εγκατάσταση
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Διαμόρφωση
Δημιουργήστε `config.yaml` με αλγόριθμο, νήματα, URL pool, διεύθυνση πορτοφολιού.

## Εκτέλεση Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ΔΙΕΥΘΥΝΣΗ --worker worker1
```

## Υποστήριξη
- GitHub: https://github.com/otedama/otedama
