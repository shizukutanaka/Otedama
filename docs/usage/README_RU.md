# Otedama - Руководство по использованию P2P майнинг-пула

## Содержание
1. [Установка](#установка)
2. [Конфигурация](#конфигурация)
3. [Запуск Otedama](#запуск-otedama)
4. [Операции майнинга](#операции-майнинга)
5. [Управление пулом](#управление-пулом)
6. [Мониторинг](#мониторинг)
7. [Устранение неполадок](#устранение-неполадок)

## Установка

### Системные требования
- Операционная система: Linux, Windows, macOS
- ОЗУ: Минимум 4ГБ, Рекомендуется 8ГБ+
- Хранилище: 50ГБ+ свободного места
- Сеть: Стабильное интернет-соединение

### Быстрая установка
```bash
# Скачать последнюю версию
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64

# Или собрать из исходников
git clone https://github.com/otedama/otedama.git
cd otedama
go build -o otedama cmd/otedama/main.go
```

## Конфигурация

### Базовая конфигурация
Создайте `config.yaml`:
```yaml
mining:
  algorithm: sha256d
  threads: 4
  intensity: 10

pool:
  url: stratum+tcp://pool.example.com:3333
  wallet_address: ВАШ_АДРЕС_КОШЕЛЬКА
  worker_name: worker1

p2p:
  enabled: true
  listen_addr: 0.0.0.0:19333
  max_peers: 50
```

## Запуск Otedama

### Соло-майнинг
```bash
./otedama --solo --algorithm sha256d --threads 8
```

### Майнинг в пуле
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ВАШ_КОШЕЛЕК --worker worker1
```

### P2P режим пула
```bash
./otedama --p2p --listen 0.0.0.0:19333 --bootstrap node1.example.com:19333,node2.example.com:19333
```

## Операции майнинга

### Поддерживаемые алгоритмы
- SHA256d (Bitcoin)
- Scrypt (Litecoin)
- Ethash (Ethereum Classic)
- KawPow (Ravencoin)
- RandomX (Monero)
- Autolykos2 (Ergo)

### Оптимизация оборудования
```bash
# CPU майнинг с SIMD оптимизацией
./otedama --cpu --optimize simd

# GPU майнинг с несколькими устройствами
./otedama --gpu --devices 0,1,2,3

# ASIC майнинг
./otedama --asic --model antminer-s19
```

## Поддержка

- GitHub: https://github.com/otedama/otedama
