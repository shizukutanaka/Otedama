# Otedama v0.5

**Plateforme P2P de Minage + DEX + DeFi Entièrement Automatisée**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md)

---

## Aperçu

Otedama est une plateforme commerciale de pool de minage P2P, DEX et DeFi entièrement automatisée. Construite selon les philosophies de conception de John Carmack (performance d'abord), Robert C. Martin (architecture propre) et Rob Pike (simplicité).

### Caractéristiques Principales

- **Opération Entièrement Automatique** - Aucune intervention manuelle requise
- **Système de Frais Immuable** - Collecte automatique non modifiable de 1,5% en BTC
- **Support Multi-Algorithme** - Compatible CPU/GPU/ASIC
- **DEX Unifié** - V2 AMM + V3 Liquidité Concentrée
- **Paiement Automatique** - Paiements automatiques des récompenses aux mineurs toutes les heures
- **Fonctionnalités DeFi** - Auto-liquidation, gouvernance, bridges
- **Niveau Entreprise** - Supporte 10 000+ mineurs

### Caractéristiques d'Automatisation Opérationnelle

1. **Collecte Automatique des Frais**
   - Adresse BTC : 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (immuable)
   - Frais du Pool : 0% (supprimés)
   - Frais Opérationnels : 1,5% (non modifiable)
   - Frais Totaux : 1,5% (frais opérationnels uniquement)
   - Fréquence de Collecte : Toutes les 5 minutes
   - Conversion automatique de toutes les devises en BTC

2. **Distribution Automatique des Récompenses de Minage**
   - Exécution toutes les heures
   - Déduction automatique des frais du pool
   - Envoi automatique à l'atteinte du paiement minimum
   - Enregistrement automatique des transactions

3. **DEX/DeFi Entièrement Automatisé**
   - Rééquilibrage automatique des pools de liquidité
   - Auto-liquidation (85% LTV)
   - Exécution automatique des propositions de gouvernance
   - Relais automatique des bridges cross-chain

---

## Configuration Requise

### Configuration Minimale
- Node.js 18+
- RAM : 2 Go
- Stockage : 10 Go SSD
- Réseau : 100 Mbps

### Configuration Recommandée
- CPU : 8+ cœurs
- RAM : 8 Go+
- Stockage : 100 Go NVMe SSD
- Réseau : 1 Gbps

---

## Installation

### 1. Installation de Base

```bash
# Cloner le dépôt
git clone https://github.com/otedama/otedama.git
cd otedama

# Installer les dépendances
npm install

# Démarrer
npm start
```

### 2. Installation Docker

```bash
# Démarrer avec Docker Compose
docker-compose up -d

# Vérifier les logs
docker-compose logs -f otedama
```

### 3. Installation en Un Clic

**Windows :**
```batch
.\quickstart.bat
```

**Linux/macOS :**
```bash
chmod +x quickstart.sh
./quickstart.sh
```

---

## Configuration

### Configuration de Base

Éditer `otedama.json` :

```json
{
  "pool": {
    "name": "Nom de Votre Pool",
    "fee": 1.0,
    "minPayout": {
      "BTC": 0.001,
      "RVN": 100,
      "XMR": 0.1
    }
  },
  "mining": {
    "currency": "RVN",
    "algorithm": "kawpow",
    "walletAddress": "Votre Adresse de Portefeuille"
  }
}
```

### Configuration en Ligne de Commande

```bash
# Démarrage de base
node index.js --wallet RYourWalletAddress --currency RVN

# Haute performance
node index.js --threads 16 --max-miners 5000 --enable-dex

# Ports personnalisés
node index.js --api-port 9080 --stratum-port 4444
```

---

## Connexion des Mineurs

### Informations de Connexion
- Serveur : `VOTRE_IP:3333`
- Nom d'utilisateur : `AdressePortefeuille.NomTravailleur`
- Mot de passe : `x`

### Exemples de Logiciels de Minage

**T-Rex (NVIDIA) :**
```bash
t-rex -a kawpow -o stratum+tcp://VOTRE_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD) :**
```bash
teamredminer -a kawpow -o stratum+tcp://VOTRE_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU) :**
```bash
xmrig -o VOTRE_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Devises Supportées

| Devise | Algorithme | Paiement Min | Frais |
|--------|------------|--------------|-------|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Toutes les devises : 1,5% de frais fixes (frais opérationnels uniquement) - non modifiable

---

## API

### Points de Terminaison REST

```bash
# Statistiques du pool
GET /api/stats

# État de collecte des frais
GET /api/fees

# Informations sur les mineurs
GET /api/miners/{minerId}

# Prix DEX
GET /api/dex/prices

# Santé du système
GET /health
```

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:8080');
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['stats', 'mining', 'dex']
}));
```

---

## Informations pour les Opérateurs

### Structure des Revenus

1. **Frais Opérationnels** : 1,5% fixes (non modifiable)
2. **Frais DEX** : 0,3% (distribués aux fournisseurs de liquidité)
3. **Frais DeFi** : Portion des intérêts de prêt

### Tâches Automatisées

- **Toutes les 5 minutes** : Conversion et collecte des frais opérationnels en BTC
- **Toutes les 10 minutes** : Rééquilibrage des pools DEX
- **Toutes les 30 minutes** : Vérification de liquidation DeFi
- **Toutes les heures** : Paiements automatiques aux mineurs
- **Toutes les 24 heures** : Optimisation et sauvegarde de la base de données

### Surveillance

Tableau de Bord : `http://localhost:8080`

Métriques Clés :
- Mineurs actifs
- Taux de hash
- Revenus des frais
- Volume DEX
- Ressources système

---

## Sécurité

### Protections Implémentées

1. **Protection DDoS**
   - Limitation de débit multicouche
   - Seuils adaptatifs
   - Défi-réponse

2. **Système d'Authentification**
   - JWT + MFA
   - Contrôle d'accès basé sur les rôles
   - Gestion des clés API

3. **Prévention de la Manipulation**
   - Adresse de frais opérationnels immuable
   - Vérifications d'intégrité du système
   - Journaux d'audit

---

## Dépannage

### Port en Utilisation
```bash
# Vérifier le processus utilisant le port
netstat -tulpn | grep :8080

# Arrêter le processus
kill -9 PID
```

### Problèmes de Mémoire
```bash
# Augmenter la limite de mémoire Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Mode Debug
```bash
DEBUG=* node index.js
```

---

## Optimisation des Performances

### Fonctionnalités d'Optimisation

- **Traitement par Lots de Base de Données** : 70% plus rapide
- **Optimisation Réseau** : Réduction de 40% de la bande passante
- **Cache Avancé** : Taux de réussite de 85%+
- **Opérations sans Copie** : Traitement de minage efficace

### Résultats de Benchmark

```bash
# Exécuter le benchmark
npm run benchmark

# Résultats (8 cœurs, 16 Go RAM) :
- Base de données : 50 000+ ops/sec
- Réseau : 10 000+ msg/sec
- Taux de réussite du cache : 85%+
- Utilisation mémoire : <100 Mo (base)
```

---

## Licence

Licence MIT - Utilisation commerciale autorisée

## Support

GitHub Issues : https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - L'Avenir du Minage Automatisé

---