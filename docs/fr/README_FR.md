# Otedama - Pool de Minage P2P et Logiciel de Minage d'Entreprise

**Version**: 2.1.6  
**Licence**: MIT  
**Version Go**: 1.21+  
**Architecture**: Microservices avec support de pool P2P  
**Date de publication**: 6 août 2025

Otedama est un pool de minage P2P et un logiciel de minage de niveau entreprise conçu pour une efficacité et une fiabilité maximales. Construit selon les principes de conception de John Carmack (performance), Robert C. Martin (architecture propre) et Rob Pike (simplicité), il prend en charge le minage complet CPU/GPU/ASIC avec une évolutivité au niveau national.

## Architecture

### Pool de Minage P2P
- **Gestion de Pool Distribuée**: Pool de minage distribué avec basculement automatique
- **Distribution des Récompenses**: Algorithmes PPS/PPLNS avancés avec support multi-devises
- **Protocole de Fédération**: Communication inter-pools pour une résilience accrue
- **Surveillance de Niveau National**: Surveillance d'entreprise adaptée aux déploiements gouvernementaux

### Fonctionnalités de Minage
- **Multi-Algorithmes**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Matériel Universel**: Optimisé pour CPU, GPU (CUDA/OpenCL), ASIC
- **Stratum Avancé**: Support complet v1/v2 avec extensions pour mineurs haute performance
- **Optimisations Zéro-Copie**: Structures de données conscientes du cache et mémoire consciente NUMA

### Fonctionnalités d'Entreprise
- **Prêt pour la Production**: Déploiement Docker/Kubernetes avec auto-scaling
- **Sécurité d'Entreprise**: Protection DDoS, limitation de débit, audit complet
- **Haute Disponibilité**: Configuration multi-nœuds avec basculement automatique
- **Analyse en Temps Réel**: API WebSocket avec intégration de tableau de bord en direct

## Exigences

- Go 1.21 ou supérieur
- Linux, macOS, Windows
- Matériel de minage (CPU/GPU/ASIC)
- Connexion réseau au pool de minage

## Installation

### Depuis les sources

```bash
# Construire dans le répertoire source
cd Otedama

# Construire le binaire
make build

# Installer dans le système
make install
```

### Utiliser Go Build

```bash
go build ./cmd/otedama
```

### Docker Production

```bash
# Déploiement de production
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Déployer la pile complète
kubectl apply -f k8s/
```

## Démarrage Rapide

### 1. Configuration

```yaml
# Configuration de production avec support de pool P2P
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Détection automatique
    priority: "normal"
  
  gpu:
    devices: [] # Détection automatique de tous les appareils
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Découverte automatique
    poll_interval: 5s

pool:
  enable: true
  address: "0.0.0.0:3333"
  max_connections: 10000
  fee_percentage: 1.0
  rewards:
    system: "PPLNS"
    window: 2h

api:
  enable: true
  address: "0.0.0.0:8080"
  auth:
    enabled: true
    token_expiry: 24h

monitoring:
  metrics:
    enabled: true
    address: "0.0.0.0:9090"
  health:
    enabled: true
    address: "0.0.0.0:8081"
```

### 2. Options de Déploiement

```bash
# Développement
./otedama serve --config config.yaml

# Production Docker
docker-compose -f docker-compose.production.yml up -d

# Entreprise Kubernetes
kubectl apply -f k8s/

# Déploiement manuel de production
sudo ./scripts/production-deploy.sh
```

### 3. Surveillance des Performances

```bash
# Vérifier le statut
./otedama status

# Voir les journaux
tail -f logs/otedama.log

# Point de terminaison API
curl http://localhost:8080/api/status
```

## Performances

Otedama est optimisé pour une efficacité maximale :

- **Utilisation Mémoire**: Optimisé pour une empreinte mémoire minimale
- **Taille Binaire**: Taille compacte (~15MB)
- **Temps de Démarrage**: <500ms
- **Surcharge CPU**: <1% pour la surveillance

## Référence API

### Points de Terminaison REST

- `GET /api/status` - Statut du minage
- `GET /api/stats` - Statistiques détaillées
- `GET /api/workers` - Informations sur les workers
- `POST /api/mining/start` - Démarrer le minage
- `POST /api/mining/stop` - Arrêter le minage

### WebSocket

Connectez-vous à `ws://localhost:8080/api/ws` pour les mises à jour en temps réel.

## Déploiement

### Docker Compose

```yaml
version: '3.8'
services:
  otedama:
    build: .
    volumes:
      - ./config.yaml:/config.yaml
    ports:
      - "8080:8080"
      - "3333:3333"
    restart: unless-stopped
```

### Kubernetes

```bash
kubectl apply -f k8s/
```

## Contribution

Les contributions sont les bienvenues ! Veuillez suivre les pratiques de développement standard :

1. Créer une branche de fonctionnalité
2. Effectuer les modifications
3. Tester minutieusement
4. Soumettre pour révision

## Licence

Ce projet est sous licence MIT - voir le fichier [LICENSE](LICENSE) pour les détails.

## Remerciements

- Développeurs Bitcoin Core pour les protocoles de minage
- Communauté Go pour d'excellentes bibliothèques
- Tous les contributeurs et utilisateurs d'Otedama

## Support

- Consultez la documentation dans le répertoire `docs/`
- Consultez les exemples de configuration dans `config.example.yaml`
- Consultez la documentation API à `/api/docs` lors de l'exécution

## Dons

Si vous trouvez Otedama utile, veuillez envisager de soutenir le développement :

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Votre support aide à maintenir et améliorer Otedama !

---

**⚠️ Important**: Le minage de cryptomonnaies consomme des ressources informatiques et de l'électricité importantes. Veuillez comprendre les coûts et l'impact environnemental avant de commencer le minage.