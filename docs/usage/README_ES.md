# Otedama - Guía de Uso del Software de Pool de Minería P2P

## Tabla de Contenidos
1. [Instalación](#instalación)
2. [Configuración](#configuración)
3. [Ejecutar Otedama](#ejecutar-otedama)
4. [Operaciones de Minería](#operaciones-de-minería)
5. [Gestión del Pool](#gestión-del-pool)
6. [Monitoreo](#monitoreo)
7. [Solución de Problemas](#solución-de-problemas)

## Instalación

### Requisitos del Sistema
- Sistema Operativo: Linux, Windows, macOS
- RAM: Mínimo 4GB, Recomendado 8GB+
- Almacenamiento: 50GB+ espacio libre
- Red: Conexión a internet estable

### Instalación Rápida
```bash
# Descargar última versión
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64

# O compilar desde fuente
git clone https://github.com/otedama/otedama.git
cd otedama
go build -o otedama cmd/otedama/main.go
```

## Configuración

### Configuración Básica
Crear `config.yaml`:
```yaml
mining:
  algorithm: sha256d
  threads: 4
  intensity: 10

pool:
  url: stratum+tcp://pool.example.com:3333
  wallet_address: TU_DIRECCIÓN_DE_BILLETERA
  worker_name: worker1

p2p:
  enabled: true
  listen_addr: 0.0.0.0:19333
  max_peers: 50
```

### Configuración Avanzada
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

## Ejecutar Otedama

### Minería en Solitario
```bash
./otedama --solo --algorithm sha256d --threads 8
```

### Minería en Pool
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet TU_BILLETERA --worker worker1
```

### Modo Pool P2P
```bash
./otedama --p2p --listen 0.0.0.0:19333 --bootstrap node1.example.com:19333,node2.example.com:19333
```

### Despliegue con Docker
```bash
docker run -d \
  --name otedama \
  -p 19333:19333 \
  -p 8080:8080 \
  -v ./config.yaml:/config.yaml \
  otedama/otedama:latest
```

## Operaciones de Minería

### Algoritmos Soportados
- SHA256d (Bitcoin)
- Scrypt (Litecoin)
- Ethash (Ethereum Classic)
- KawPow (Ravencoin)
- RandomX (Monero)
- Autolykos2 (Ergo)

### Optimización de Hardware
```bash
# Minería CPU con optimización SIMD
./otedama --cpu --optimize simd

# Minería GPU con múltiples dispositivos
./otedama --gpu --devices 0,1,2,3

# Minería ASIC
./otedama --asic --model antminer-s19
```

### Ajuste de Rendimiento
```bash
# Ajustar intensidad (1-20)
./otedama --intensity 15

# Optimización de memoria
./otedama --memory-pool 2048

# Optimización de red
./otedama --low-latency --max-connections 100
```

## Gestión del Pool

### Iniciar Servidor del Pool
```bash
./otedama pool --listen 0.0.0.0:3333 --fee 1.0 --min-payout 0.001
```

### Gestión de Trabajadores
```bash
# Listar trabajadores
./otedama workers list

# Agregar trabajador
./otedama workers add --name worker1 --wallet DIRECCIÓN

# Eliminar trabajador
./otedama workers remove worker1

# Ver estadísticas del trabajador
./otedama workers stats worker1
```

### Configuración de Pagos
```yaml
pool:
  payout_scheme: PPLNS  # o PPS, PROP
  payout_interval: 24h
  min_payout: 0.001
  fee_percent: 1.0
```

## Monitoreo

### Panel Web
Acceder en `http://localhost:8080`

Características:
- Gráficos de hashrate en tiempo real
- Estadísticas de trabajadores
- Métricas de rendimiento del pool
- Historial de pagos

### Monitoreo por Línea de Comandos
```bash
# Ver estadísticas actuales
./otedama stats

# Monitoreo en tiempo real
./otedama monitor

# Exportar métricas
./otedama metrics export --format json
```

### Integración con Prometheus
```yaml
monitoring:
  prometheus_enabled: true
  prometheus_port: 9090
```

### Configuración de Alertas
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

## Solución de Problemas

### Problemas Comunes

#### Problemas de Conexión
```bash
# Probar conexión al pool
./otedama test --pool stratum+tcp://pool.example.com:3333

# Depurar red
./otedama --debug --verbose
```

#### Problemas de Rendimiento
```bash
# Ejecutar benchmark
./otedama benchmark --duration 60

# Perfilar uso de CPU
./otedama --profile cpu.prof
```

#### Detección de Hardware
```bash
# Escanear hardware
./otedama hardware scan

# Probar dispositivo específico
./otedama hardware test --gpu 0
```

### Archivos de Log
```bash
# Ver logs
tail -f /var/log/otedama/otedama.log

# Cambiar nivel de log
./otedama --log-level debug
```

### Modo de Recuperación
```bash
# Iniciar en modo seguro
./otedama --safe-mode

# Reiniciar configuración
./otedama --reset-config

# Reparar base de datos
./otedama db repair
```

## Referencia API

### REST API
```bash
# Obtener estado
curl http://localhost:8080/api/status

# Obtener trabajadores
curl http://localhost:8080/api/workers

# Enviar share
curl -X POST http://localhost:8080/api/submit \
  -H "Content-Type: application/json" \
  -d '{"worker":"worker1","nonce":"12345678"}'
```

### WebSocket API
```javascript
const ws = new WebSocket('ws://localhost:8080/ws');
ws.on('message', (data) => {
  console.log('Recibido:', data);
});
```

## Seguridad

### Autenticación
```yaml
security:
  auth_enabled: true
  jwt_secret: TU_CLAVE_SECRETA
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

### Reglas de Firewall
```bash
# Permitir Stratum
iptables -A INPUT -p tcp --dport 3333 -j ACCEPT

# Permitir P2P
iptables -A INPUT -p tcp --dport 19333 -j ACCEPT

# Permitir monitoreo
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
```

## Soporte

- GitHub: https://github.com/otedama/otedama
