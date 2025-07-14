# Otedama v0.5

**Plataforma P2P de Minería + DEX + DeFi Totalmente Automatizada**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md)

---

## Resumen

Otedama es una plataforma de minería P2P, DEX y DeFi de grado comercial totalmente automatizada. Construida siguiendo las filosofías de diseño de John Carmack (rendimiento primero), Robert C. Martin (arquitectura limpia) y Rob Pike (simplicidad).

### Características Principales

- **Operación Totalmente Automática** - No requiere intervención manual
- **Sistema de Tarifas Inmutable** - Cobro automático no modificable del 1.5% en BTC
- **Soporte Multi-Algoritmo** - Compatible con CPU/GPU/ASIC
- **DEX Unificado** - V2 AMM + V3 Liquidez Concentrada
- **Auto-Pago** - Pagos automáticos de recompensas a mineros cada hora
- **Funciones DeFi** - Auto-liquidación, gobernanza, puentes
- **Grado Empresarial** - Soporta 10,000+ mineros

### Características de Automatización Operativa

1. **Cobro Automático de Tarifas**
   - Dirección BTC: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (inmutable)
   - Tarifa del Pool: 0% (eliminada)
   - Tarifa Operacional: 1.5% (no modificable)
   - Tarifa Total: 1.5% (solo tarifa operacional)
   - Frecuencia de Cobro: Cada 5 minutos
   - Auto-convierte todas las monedas a BTC

2. **Distribución Automática de Recompensas de Minería**
   - Ejecuta cada hora
   - Auto-deduce tarifas del pool
   - Auto-envía cuando se alcanza el pago mínimo
   - Auto-registra transacciones

3. **DEX/DeFi Totalmente Automatizado**
   - Auto-rebalancea pools de liquidez
   - Auto-liquidación (85% LTV)
   - Auto-ejecuta propuestas de gobernanza
   - Auto-retransmite puentes cross-chain

---

## Requisitos del Sistema

### Requisitos Mínimos
- Node.js 18+
- RAM: 2GB
- Almacenamiento: 10GB SSD
- Red: 100Mbps

### Requisitos Recomendados
- CPU: 8+ núcleos
- RAM: 8GB+
- Almacenamiento: 100GB NVMe SSD
- Red: 1Gbps

---

## Instalación

### 1. Instalación Básica

```bash
# Clonar repositorio
git clone https://github.com/otedama/otedama.git
cd otedama

# Instalar dependencias
npm install

# Iniciar
npm start
```

### 2. Instalación Docker

```bash
# Iniciar con Docker Compose
docker-compose up -d

# Verificar logs
docker-compose logs -f otedama
```

### 3. Instalación con Un Clic

**Windows:**
```batch
.\quickstart.bat
```

**Linux/macOS:**
```bash
chmod +x quickstart.sh
./quickstart.sh
```

---

## Configuración

### Configuración Básica

Editar `otedama.json`:

```json
{
  "pool": {
    "name": "Nombre de Tu Pool",
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
    "walletAddress": "Tu Dirección de Wallet"
  }
}
```

### Configuración por Línea de Comandos

```bash
# Inicio básico
node index.js --wallet RYourWalletAddress --currency RVN

# Alto rendimiento
node index.js --threads 16 --max-miners 5000 --enable-dex

# Puertos personalizados
node index.js --api-port 9080 --stratum-port 4444
```

---

## Conexión de Mineros

### Información de Conexión
- Servidor: `TU_IP:3333`
- Usuario: `DirecciónWallet.NombreTrabajador`
- Contraseña: `x`

### Ejemplos de Software de Minería

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://TU_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://TU_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o TU_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Monedas Soportadas

| Moneda | Algoritmo | Pago Mínimo | Tarifa |
|--------|-----------|-------------|--------|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

Todas las monedas: 1.5% tarifa fija (solo tarifa operacional) - no modificable

---

## API

### Endpoints REST

```bash
# Estadísticas del pool
GET /api/stats

# Estado de cobro de tarifas
GET /api/fees

# Información del minero
GET /api/miners/{minerId}

# Precios DEX
GET /api/dex/prices

# Salud del sistema
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

## Información para Operadores

### Estructura de Ingresos

1. **Tarifa Operacional**: 1.5% fija (no modificable)
2. **Tarifa DEX**: 0.3% (distribuida a proveedores de liquidez)
3. **Tarifa DeFi**: Porción del interés de préstamos

### Tareas Automatizadas

- **Cada 5 minutos**: Conversión y cobro de tarifa operacional a BTC
- **Cada 10 minutos**: Rebalanceo de pools DEX
- **Cada 30 minutos**: Verificación de liquidación DeFi
- **Cada hora**: Pagos automáticos a mineros
- **Cada 24 horas**: Optimización y respaldo de base de datos

### Monitoreo

Panel de Control: `http://localhost:8080`

Métricas Clave:
- Mineros activos
- Tasa de hash
- Ingresos por tarifas
- Volumen DEX
- Recursos del sistema

---

## Seguridad

### Protecciones Implementadas

1. **Protección DDoS**
   - Límite de tasa multicapa
   - Umbrales adaptativos
   - Desafío-respuesta

2. **Sistema de Autenticación**
   - JWT + MFA
   - Control de acceso basado en roles
   - Gestión de claves API

3. **Prevención de Manipulación**
   - Dirección de tarifa operacional inmutable
   - Verificaciones de integridad del sistema
   - Registros de auditoría

---

## Solución de Problemas

### Puerto en Uso
```bash
# Verificar proceso usando el puerto
netstat -tulpn | grep :8080

# Detener proceso
kill -9 PID
```

### Problemas de Memoria
```bash
# Aumentar límite de memoria de Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Modo Debug
```bash
DEBUG=* node index.js
```

---

## Optimización de Rendimiento

### Características de Optimización

- **Procesamiento por Lotes de Base de Datos**: 70% más rápido
- **Optimización de Red**: 40% reducción de ancho de banda
- **Caché Avanzado**: 85%+ tasa de aciertos
- **Operaciones sin Copia**: Procesamiento eficiente de minería

### Resultados de Benchmark

```bash
# Ejecutar benchmark
npm run benchmark

# Resultados (8 núcleos, 16GB RAM):
- Base de datos: 50,000+ ops/seg
- Red: 10,000+ msg/seg
- Tasa de aciertos de caché: 85%+
- Uso de memoria: <100MB (base)
```

---

## Licencia

Licencia MIT - Se permite uso comercial

## Soporte

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - El Futuro de la Minería Automatizada

---