# Registro de cambios

Todos los cambios notables de Otedama se documentarán en este archivo.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/),
y este proyecto se adhiere al [Versionado Semántico](https://semver.org/lang/es/).

## [2.1.4] - 2024-01-20

### Añadido
- Funcionalidad de pool de minería P2P de nivel empresarial
- Soporte multi-moneda con algoritmos de recompensa PPS/PPLNS
- Protocolo de federación para comunicación entre pools
- Capacidades de monitoreo a nivel nacional
- Protocolo Stratum v1/v2 avanzado con extensiones de alto rendimiento
- Optimizaciones de cero copia para mejorar el rendimiento
- Asignación de memoria consciente de NUMA
- Monitoreo integral de hardware (CPU/GPU/ASIC)
- API WebSocket en tiempo real para actualizaciones en vivo
- Características de seguridad empresarial (protección DDoS, limitación de velocidad)
- Despliegue Docker/Kubernetes con escalado automático
- Soporte multilingüe (30 idiomas)

### Cambiado
- Arquitectura actualizada a microservicios con soporte de pool P2P
- Motor de minería mejorado con estructuras de datos conscientes del caché
- Sistema de configuración mejorado con validación
- API actualizada con puntos finales de monitoreo integrales
- Guías de despliegue modernizadas para uso empresarial

### Corregido
- Problemas de fuga de memoria en trabajadores de minería
- Errores de compilación en paquetes de criptografía y memoria
- Dependencias cíclicas de importación
- Consolidación de archivos duplicados en toda la base de código

### Seguridad
- Protección DDoS integral añadida
- Autenticación de nivel empresarial implementada
- Validación y sanitización de entrada mejoradas
- Registro de auditoría de seguridad añadido

## [2.1.3] - 2024-01-15

### Añadido
- Optimización y limpieza importante del código
- Patrones de manejo de errores mejorados
- Sistema de registro mejorado

### Cambiado
- Implementación criptográfica simplificada
- Funcionalidad duplicada consolidada
- Uso de memoria optimizado

### Corregido
- Varios errores menores y problemas

## [2.1.2] - 2024-01-10

### Añadido
- Suite de benchmarks inicial
- Herramientas de monitoreo de rendimiento

### Cambiado
- Dependencias actualizadas
- Documentación mejorada

### Corregido
- Problemas de carga de configuración

## [2.1.1] - 2024-01-05

### Añadido
- Funcionalidad básica de minería
- Implementación inicial de API

### Cambiado
- Mejoras en la estructura del proyecto

### Corregido
- Problemas del sistema de compilación

## [2.1.0] - 2024-01-01

### Añadido
- Lanzamiento inicial de Otedama
- Soporte básico de minería CPU
- Sistema de configuración simple
- Puntos finales de API REST