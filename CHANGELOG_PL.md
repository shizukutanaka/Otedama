# Historia zmian

Wszystkie znaczące zmiany w Otedama będą dokumentowane w tym pliku.

Format jest oparty na [Keep a Changelog](https://keepachangelog.com/pl/1.0.0/),
a ten projekt przestrzega [Wersjonowania Semantycznego](https://semver.org/lang/pl/).

## [2.1.4] - 2025-08-20

### Dodano
- Funkcjonalność puli wydobywczej P2P klasy korporacyjnej
- Obsługa wielu walut z algorytmami nagród PPS/PPLNS
- Protokół federacyjny do komunikacji między pulami
- Możliwości monitorowania na poziomie krajowym
- Zaawansowany protokół Stratum v1/v2 z rozszerzeniami wysokiej wydajności
- Optymalizacje zero-copy dla lepszej wydajności
- Alokacja pamięci świadoma NUMA
- Kompleksowe monitorowanie sprzętu (CPU/GPU/ASIC)
- API WebSocket w czasie rzeczywistym dla aktualizacji na żywo
- Funkcje bezpieczeństwa korporacyjnego (ochrona DDoS, ograniczanie prędkości)
- Wdrożenie Docker/Kubernetes z automatycznym skalowaniem
- Wsparcie wielojęzyczne (30 języków)

### Zmieniono
- Zaktualizowano architekturę do mikroserwisów z obsługą puli P2P
- Ulepszony silnik wydobywczy ze strukturami danych świadomymi pamięci podręcznej
- Ulepszony system konfiguracji z walidacją
- Zaktualizowane API z kompleksowymi punktami końcowymi monitorowania
- Zmodernizowane przewodniki wdrożeniowe do użytku korporacyjnego

### Naprawiono
- Problemy z wyciekami pamięci w pracownikach wydobywczych
- Błędy kompilacji w pakietach kryptograficznych i pamięciowych
- Cykliczne zależności importu
- Konsolidacja zduplikowanych plików w całej bazie kodu

### Bezpieczeństwo
- Dodano kompleksową ochronę DDoS
- Zaimplementowano uwierzytelnianie klasy korporacyjnej
- Ulepszona walidacja i sanityzacja danych wejściowych
- Dodano rejestrowanie audytu bezpieczeństwa

## [2.1.3] - 2025-08-15

### Dodano
- Główna optymalizacja i czyszczenie kodu
- Ulepszone wzorce obsługi błędów
- Ulepszony system logowania

### Zmieniono
- Uproszczona implementacja kryptograficzna
- Skonsolidowana zduplikowana funkcjonalność
- Zoptymalizowane użycie pamięci

### Naprawiono
- Różne drobne błędy i problemy

## [2.1.2] - 2025-08-10

### Dodano
- Początkowy zestaw testów porównawczych
- Narzędzia monitorowania wydajności

### Zmieniono
- Zaktualizowane zależności
- Ulepszona dokumentacja

### Naprawiono
- Problemy z ładowaniem konfiguracji

## [2.1.1] - 2025-08-05

### Dodano
- Podstawowa funkcjonalność wydobywcza
- Początkowa implementacja API

### Zmieniono
- Ulepszenia struktury projektu

### Naprawiono
- Problemy z systemem budowania

## [2.1.0] - 2025-08-01

### Dodano
- Początkowe wydanie Otedama
- Podstawowa obsługa wydobywania CPU
- Prosty system konfiguracji
- Punkty końcowe API REST