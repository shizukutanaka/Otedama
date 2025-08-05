# Journal des modifications

Tous les changements notables d'Otedama seront documentés dans ce fichier.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/),
et ce projet adhère au [Versionnement Sémantique](https://semver.org/lang/fr/).

## [2.1.4] - 2025-08-20

### Ajouté
- Fonctionnalité de pool de minage P2P de niveau entreprise
- Support multi-devises avec algorithmes de récompense PPS/PPLNS
- Protocole de fédération pour la communication inter-pools
- Capacités de surveillance au niveau national
- Protocole Stratum v1/v2 avancé avec extensions haute performance
- Optimisations zero-copy pour améliorer les performances
- Allocation mémoire sensible à NUMA
- Surveillance matérielle complète (CPU/GPU/ASIC)
- API WebSocket temps réel pour les mises à jour en direct
- Fonctionnalités de sécurité d'entreprise (protection DDoS, limitation de débit)
- Déploiement Docker/Kubernetes avec mise à l'échelle automatique
- Support multilingue (30 langues)

### Modifié
- Architecture mise à niveau vers les microservices avec support de pool P2P
- Moteur de minage amélioré avec structures de données sensibles au cache
- Système de configuration amélioré avec validation
- API mise à jour avec points de terminaison de surveillance complets
- Guides de déploiement modernisés pour une utilisation en entreprise

### Corrigé
- Problèmes de fuite mémoire dans les workers de minage
- Erreurs de compilation dans les packages crypto et mémoire
- Dépendances cycliques d'importation
- Consolidation des fichiers dupliqués dans toute la base de code

### Sécurité
- Protection DDoS complète ajoutée
- Authentification de niveau entreprise implémentée
- Validation et assainissement des entrées améliorés
- Journalisation d'audit de sécurité ajoutée

## [2.1.3] - 2025-08-15

### Ajouté
- Optimisation et nettoyage majeurs du code
- Modèles de gestion d'erreurs améliorés
- Système de journalisation amélioré

### Modifié
- Implémentation cryptographique simplifiée
- Fonctionnalité dupliquée consolidée
- Utilisation de la mémoire optimisée

### Corrigé
- Divers bugs et problèmes mineurs

## [2.1.2] - 2025-08-10

### Ajouté
- Suite de benchmarks initiale
- Outils de surveillance des performances

### Modifié
- Dépendances mises à jour
- Documentation améliorée

### Corrigé
- Problèmes de chargement de configuration

## [2.1.1] - 2025-08-05

### Ajouté
- Fonctionnalité de minage de base
- Implémentation API initiale

### Modifié
- Améliorations de la structure du projet

### Corrigé
- Problèmes du système de construction

## [2.1.0] - 2025-08-01

### Ajouté
- Version initiale d'Otedama
- Support de minage CPU de base
- Système de configuration simple
- Points de terminaison API REST