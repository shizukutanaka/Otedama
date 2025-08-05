# Änderungsprotokoll

Alle bemerkenswerten Änderungen an Otedama werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt hält sich an [Semantic Versioning](https://semver.org/lang/de/).

## [2.1.4] - 2024-01-20

### Hinzugefügt
- Enterprise-Grade P2P Mining-Pool-Funktionalität
- Multi-Währungsunterstützung mit PPS/PPLNS-Belohnungsalgorithmen
- Föderationsprotokoll für die Kommunikation zwischen Pools
- Überwachungsfunktionen auf nationaler Ebene
- Fortgeschrittenes Stratum v1/v2-Protokoll mit Hochleistungserweiterungen
- Zero-Copy-Optimierungen für verbesserte Leistung
- NUMA-bewusste Speicherzuweisung
- Umfassende Hardware-Überwachung (CPU/GPU/ASIC)
- Echtzeit-WebSocket-API für Live-Updates
- Enterprise-Sicherheitsfunktionen (DDoS-Schutz, Ratenbegrenzung)
- Docker/Kubernetes-Bereitstellung mit Auto-Skalierung
- Mehrsprachige Unterstützung (30 Sprachen)

### Geändert
- Architektur auf Microservices mit P2P-Pool-Unterstützung aktualisiert
- Mining-Engine mit cache-bewussten Datenstrukturen verbessert
- Konfigurationssystem mit Validierung verbessert
- API mit umfassenden Überwachungsendpunkten aktualisiert
- Bereitstellungsanleitungen für den Unternehmenseinsatz modernisiert

### Behoben
- Speicherleckprobleme in Mining-Workern
- Kompilierungsfehler in Krypto- und Speicherpaketen
- Zyklische Import-Abhängigkeiten
- Konsolidierung doppelter Dateien in der gesamten Codebasis

### Sicherheit
- Umfassender DDoS-Schutz hinzugefügt
- Enterprise-Grade-Authentifizierung implementiert
- Eingabevalidierung und -bereinigung verbessert
- Sicherheitsaudit-Protokollierung hinzugefügt

## [2.1.3] - 2024-01-15

### Hinzugefügt
- Große Code-Optimierung und -Bereinigung
- Verbesserte Fehlerbehandlungsmuster
- Erweitertes Protokollierungssystem

### Geändert
- Vereinfachte Krypto-Implementierung
- Konsolidierte doppelte Funktionalität
- Optimierte Speichernutzung

### Behoben
- Verschiedene kleinere Fehler und Probleme

## [2.1.2] - 2024-01-10

### Hinzugefügt
- Initiale Benchmark-Suite
- Leistungsüberwachungstools

### Geändert
- Abhängigkeiten aktualisiert
- Dokumentation verbessert

### Behoben
- Probleme beim Laden der Konfiguration

## [2.1.1] - 2024-01-05

### Hinzugefügt
- Grundlegende Mining-Funktionalität
- Erste API-Implementierung

### Geändert
- Verbesserungen der Projektstruktur

### Behoben
- Build-System-Probleme

## [2.1.0] - 2024-01-01

### Hinzugefügt
- Erstveröffentlichung von Otedama
- Grundlegende CPU-Mining-Unterstützung
- Einfaches Konfigurationssystem
- REST-API-Endpunkte