# Otedama - Pool de Minería P2P y Software de Minería Empresarial

**Versión**: 2.1.5  
**Licencia**: MIT  
**Versión Go**: 1.21+  
**Arquitectura**: Microservicios con soporte de pool P2P  
**Fecha de lanzamiento**: 6 de agosto de 2025

Otedama es un pool de minería P2P y software de minería de nivel empresarial diseñado para máxima eficiencia y confiabilidad. Construido siguiendo los principios de diseño de John Carmack (rendimiento), Robert C. Martin (arquitectura limpia) y Rob Pike (simplicidad), soporta minería integral CPU/GPU/ASIC con escalabilidad a nivel nacional.

## Arquitectura

### Pool de Minería P2P
- **Gestión de Pool Distribuida**: Pool de minería distribuido con failover automático
- **Distribución de Recompensas**: Algoritmos PPS/PPLNS avanzados con soporte multi-moneda
- **Protocolo de Federación**: Comunicación inter-pool para mayor resistencia
- **Monitoreo de Nivel Nacional**: Monitoreo empresarial adecuado para despliegues gubernamentales

### Características de Minería
- **Multi-Algoritmo**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Hardware Universal**: Optimizado para CPU, GPU (CUDA/OpenCL), ASIC
- **Stratum Avanzado**: Soporte completo v1/v2 con extensiones para mineros de alto rendimiento
- **Optimizaciones Zero-Copy**: Estructuras de datos conscientes de caché y memoria consciente de NUMA

### Características Empresariales
- **Listo para Producción**: Despliegue Docker/Kubernetes con auto-escalado
- **Seguridad Empresarial**: Protección DDoS, limitación de velocidad, auditoría integral
- **Alta Disponibilidad**: Configuración multi-nodo con failover automático
- **Análisis en Tiempo Real**: API WebSocket con integración de dashboard en vivo

## Requisitos

- Go 1.21 o superior
- Linux, macOS, Windows
- Hardware de minería (CPU/GPU/ASIC)
- Conexión de red al pool de minería

## Instalación

### Desde fuentes

```bash
# Construir en el directorio fuente
cd Otedama

# Construir binario
make build

# Instalar en el sistema
make install
```

### Usar Go Build

```bash
go build ./cmd/otedama
```

### Docker Producción

```bash
# Despliegue de producción
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Desplegar stack completo
kubectl apply -f k8s/
```

## Inicio Rápido

### 1. Configuración

```yaml
# Configuración de producción con soporte de pool P2P
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Auto-detección
    priority: "normal"
  
  gpu:
    devices: [] # Auto-detectar todos los dispositivos
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Auto-descubrimiento
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

### 2. Opciones de Despliegue

```bash
# Desarrollo
./otedama serve --config config.yaml

# Docker de Producción
docker-compose -f docker-compose.production.yml up -d

# Kubernetes Empresarial
kubectl apply -f k8s/

# Despliegue manual de producción
sudo ./scripts/production-deploy.sh
```

### 3. Monitoreo de Rendimiento

```bash
# Verificar estado
./otedama status

# Ver logs
tail -f logs/otedama.log

# Endpoint API
curl http://localhost:8080/api/status
```

## Rendimiento

Otedama está optimizado para máxima eficiencia:

- **Uso de Memoria**: Optimizado para huella de memoria mínima
- **Tamaño Binario**: Tamaño compacto (~15MB)
- **Tiempo de Arranque**: <500ms
- **Sobrecarga CPU**: <1% para monitoreo

## Referencia API

### Endpoints REST

- `GET /api/status` - Estado de minería
- `GET /api/stats` - Estadísticas detalladas
- `GET /api/workers` - Información de workers
- `POST /api/mining/start` - Iniciar minería
- `POST /api/mining/stop` - Detener minería

### WebSocket

Conectar a `ws://localhost:8080/api/ws` para actualizaciones en tiempo real.

## Despliegue

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

## Contribución

¡Las contribuciones son bienvenidas! Por favor siga las prácticas de desarrollo estándar:

1. Crear rama de característica
2. Realizar cambios
3. Probar minuciosamente
4. Enviar para revisión

## Licencia

Este proyecto está licenciado bajo la Licencia MIT - ver el archivo [LICENSE](LICENSE) para detalles.

## Reconocimientos

- Desarrolladores de Bitcoin Core por protocolos de minería
- Comunidad Go por excelentes librerías
- Todos los contribuidores y usuarios de Otedama

## Soporte

- Revise la documentación en el directorio `docs/`
- Revise ejemplos de configuración en `config.example.yaml`
- Consulte la documentación API en `/api/docs` durante la ejecución

## Donaciones

Si encuentra útil Otedama, considere apoyar el desarrollo:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

¡Su apoyo ayuda a mantener y mejorar Otedama!

---

**⚠️ Importante**: La minería de criptomonedas consume recursos computacionales y electricidad significativos. Por favor comprenda los costos e impacto ambiental antes de comenzar la minería.