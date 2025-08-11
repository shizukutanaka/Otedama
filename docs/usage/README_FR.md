# Otedama - Guide d'Utilisation du Logiciel de Pool de Minage P2P

## Table des Matières
1. [Installation](#installation)
2. [Configuration](#configuration)
3. [Exécuter Otedama](#exécuter-otedama)
4. [Opérations de Minage](#opérations-de-minage)
5. [Gestion du Pool](#gestion-du-pool)
6. [Surveillance](#surveillance)
7. [Dépannage](#dépannage)

## Installation

### Configuration Requise
- Système d'exploitation: Linux, Windows, macOS
- RAM: Minimum 4GB, Recommandé 8GB+
- Stockage: 50GB+ d'espace libre
- Réseau: Connexion internet stable

### Installation Rapide
```bash
# Télécharger la dernière version
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64

# Ou compiler depuis les sources
git clone https://github.com/otedama/otedama.git
cd otedama
go build -o otedama cmd/otedama/main.go
```

## Configuration

### Configuration de Base
Créer `config.yaml`:
```yaml
mining:
  algorithm: sha256d
  threads: 4
  intensity: 10

pool:
  url: stratum+tcp://pool.example.com:3333
  wallet_address: VOTRE_ADRESSE_PORTEFEUILLE
  worker_name: worker1

p2p:
  enabled: true
  listen_addr: 0.0.0.0:19333
  max_peers: 50
```

### Paramètres Avancés
```yaml
hardware:
  cpu:
    enabled: true
    threads: 8
  gpu:
    enabled: true
    devices: [0, 1]
  asic:
    enabled: false

monitoring:
  enabled: true
  listen_addr: 0.0.0.0:8080
  prometheus_enabled: true
```

## Exécuter Otedama

### Minage Solo
```bash
./otedama --solo --algorithm sha256d --threads 8
```

### Minage en Pool
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet VOTRE_PORTEFEUILLE --worker worker1
```

### Mode Pool P2P
```bash
./otedama --p2p --listen 0.0.0.0:19333 --bootstrap node1.example.com:19333,node2.example.com:19333
```

### Déploiement Docker
```bash
docker run -d \
  --name otedama \
  -p 19333:19333 \
  -p 8080:8080 \
  -v ./config.yaml:/config.yaml \
  otedama/otedama:latest
```

## Opérations de Minage

### Algorithmes Supportés
- SHA256d (Bitcoin)
- Scrypt (Litecoin)
- Ethash (Ethereum Classic)
- KawPow (Ravencoin)
- RandomX (Monero)
- Autolykos2 (Ergo)

### Optimisation du Matériel
```bash
# Minage CPU avec optimisation SIMD
./otedama --cpu --optimize simd

# Minage GPU avec plusieurs appareils
./otedama --gpu --devices 0,1,2,3

# Minage ASIC
./otedama --asic --model antminer-s19
```

### Réglage des Performances
```bash
# Ajuster l'intensité (1-20)
./otedama --intensity 15

# Optimisation de la mémoire
./otedama --memory-pool 2048

# Optimisation du réseau
./otedama --low-latency --max-connections 100
```

## Gestion du Pool

### Démarrer le Serveur du Pool
```bash
./otedama pool --listen 0.0.0.0:3333 --fee 1.0 --min-payout 0.001
```

### Gestion des Travailleurs
```bash
# Lister les travailleurs
./otedama workers list

# Ajouter un travailleur
./otedama workers add --name worker1 --wallet ADRESSE

# Supprimer un travailleur
./otedama workers remove worker1

# Voir les statistiques du travailleur
./otedama workers stats worker1
```

### Configuration des Paiements
```yaml
pool:
  payout_scheme: PPLNS  # ou PPS, PROP
  payout_interval: 24h
  min_payout: 0.001
  fee_percent: 1.0
```

## Surveillance

### Tableau de Bord Web
Accéder à `http://localhost:8080`

Fonctionnalités:
- Graphiques de hashrate en temps réel
- Statistiques des travailleurs
- Métriques de performance du pool
- Historique des paiements

### Surveillance en Ligne de Commande
```bash
# Voir les statistiques actuelles
./otedama stats

# Surveillance en temps réel
./otedama monitor

# Exporter les métriques
./otedama metrics export --format json
```

### Intégration Prometheus
```yaml
monitoring:
  prometheus_enabled: true
  prometheus_port: 9090
```

### Configuration des Alertes
```yaml
alerts:
  email:
    enabled: true
    smtp_server: smtp.gmail.com:587
    from: alerts@example.com
    to: admin@example.com
  thresholds:
    min_hashrate: 1000000
    max_temperature: 85
    min_workers: 5
```

## Dépannage

### Problèmes Courants

#### Problèmes de Connexion
```bash
# Tester la connexion au pool
./otedama test --pool stratum+tcp://pool.example.com:3333

# Déboguer le réseau
./otedama --debug --verbose
```

#### Problèmes de Performance
```bash
# Exécuter le benchmark
./otedama benchmark --duration 60

# Profiler l'utilisation CPU
./otedama --profile cpu.prof
```

#### Détection du Matériel
```bash
# Scanner le matériel
./otedama hardware scan

# Tester un appareil spécifique
./otedama hardware test --gpu 0
```

### Fichiers de Log
```bash
# Voir les logs
tail -f /var/log/otedama/otedama.log

# Changer le niveau de log
./otedama --log-level debug
```

### Mode de Récupération
```bash
# Démarrer en mode sécurisé
./otedama --safe-mode

# Réinitialiser la configuration
./otedama --reset-config

# Réparer la base de données
./otedama db repair
```

## Référence API

### REST API
```bash
# Obtenir le statut
curl http://localhost:8080/api/status

# Obtenir les travailleurs
curl http://localhost:8080/api/workers

# Soumettre un share
curl -X POST http://localhost:8080/api/submit \
  -H "Content-Type: application/json" \
  -d '{"worker":"worker1","nonce":"12345678"}'
```

### WebSocket API
```javascript
const ws = new WebSocket('ws://localhost:8080/ws');
ws.on('message', (data) => {
  console.log('Reçu:', data);
});
```

## Sécurité

### Authentification
```yaml
security:
  auth_enabled: true
  jwt_secret: VOTRE_CLÉ_SECRÈTE
  api_keys:
    - key: API_KEY_1
      permissions: [read, write]
```

### SSL/TLS
```yaml
security:
  tls_enabled: true
  cert_file: /path/to/cert.pem
  key_file: /path/to/key.pem
```

### Règles de Pare-feu
```bash
# Autoriser Stratum
iptables -A INPUT -p tcp --dport 3333 -j ACCEPT

# Autoriser P2P
iptables -A INPUT -p tcp --dport 19333 -j ACCEPT

# Autoriser la surveillance
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
```

## Support

- GitHub: https://github.com/otedama/otedama
