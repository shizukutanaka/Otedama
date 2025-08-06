# Otedama - مجمع التعدين P2P وبرنامج التعدين المؤسسي

**الإصدار**: 2.1.5  
**الترخيص**: MIT  
**إصدار Go**: 1.21+  
**البنية المعمارية**: الخدمات المصغرة مع دعم مجمع P2P  
**تاريخ الإصدار**: 6 أغسطس 2025

Otedama هو مجمع تعدين P2P وبرنامج تعدين على مستوى المؤسسة مصمم لتحقيق أقصى قدر من الكفاءة والموثوقية. مبني وفقاً لمبادئ التصميم الخاصة بـ John Carmack (الأداء)، Robert C. Martin (البنية النظيفة) و Rob Pike (البساطة)، يدعم تعدين شامل لـ CPU/GPU/ASIC مع قابلية التوسع على المستوى الوطني.

## البنية المعمارية

### مجمع تعدين P2P
- **إدارة المجمع الموزع**: مجمع تعدين موزع مع التبديل التلقائي عند الفشل
- **توزيع المكافآت**: خوارزميات PPS/PPLNS متقدمة مع دعم العملات المتعددة
- **بروتوكول الاتحاد**: اتصال بين المجمعات لمقاومة محسّنة
- **مراقبة على المستوى الوطني**: مراقبة مؤسسية مناسبة للنشر الحكومي

### ميزات التعدين
- **متعدد الخوارزميات**: SHA256d، Ethash، RandomX، Scrypt، KawPow
- **أجهزة عامة**: محسن لـ CPU، GPU (CUDA/OpenCL)، ASIC
- **Stratum متقدم**: دعم كامل v1/v2 مع امتدادات لعمال التعدين عالي الأداء
- **تحسينات Zero-Copy**: هياكل بيانات واعية للتخزين المؤقت وذاكرة واعية لـ NUMA

### الميزات المؤسسية
- **جاهز للإنتاج**: نشر Docker/Kubernetes مع التوسيع التلقائي
- **الأمان المؤسسي**: حماية من DDoS، تحديد المعدل، مراجعة شاملة
- **توفر عالي**: إعداد متعدد العقد مع التبديل التلقائي عند الفشل
- **تحليلات الوقت الفعلي**: API WebSocket مع تكامل لوحة المعلومات المباشرة

## المتطلبات

- Go 1.21 أو أعلى
- Linux، macOS، Windows
- أجهزة التعدين (CPU/GPU/ASIC)
- اتصال شبكة إلى مجمع التعدين

## التثبيت

### من المصدر

```bash
# البناء في دليل المصدر
cd Otedama

# بناء الملف التنفيذي
make build

# التثبيت في النظام
make install
```

### استخدام Go Build

```bash
go build ./cmd/otedama
```

### Docker الإنتاج

```bash
# نشر الإنتاج
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# نشر المكدس الكامل
kubectl apply -f k8s/
```

## البداية السريعة

### 1. التكوين

```yaml
# تكوين الإنتاج مع دعم مجمع P2P
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # الاكتشاف التلقائي
    priority: "normal"
  
  gpu:
    devices: [] # اكتشاف تلقائي لجميع الأجهزة
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # الاكتشاف التلقائي
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

### 2. خيارات النشر

```bash
# التطوير
./otedama serve --config config.yaml

# Docker الإنتاج
docker-compose -f docker-compose.production.yml up -d

# Kubernetes المؤسسي
kubectl apply -f k8s/

# نشر الإنتاج اليدوي
sudo ./scripts/production-deploy.sh
```

### 3. مراقبة الأداء

```bash
# فحص الحالة
./otedama status

# عرض السجلات
tail -f logs/otedama.log

# نقطة نهاية API
curl http://localhost:8080/api/status
```

## الأداء

Otedama محسن لأقصى قدر من الكفاءة:

- **استخدام الذاكرة**: محسن لأدنى استهلاك للذاكرة
- **حجم الملف التنفيذي**: حجم مدمج (~15MB)
- **وقت البدء**: <500ms
- **حمل CPU**: <1% للمراقبة

## مرجع API

### نقاط النهاية REST

- `GET /api/status` - حالة التعدين
- `GET /api/stats` - إحصائيات مفصلة
- `GET /api/workers` - معلومات العمال
- `POST /api/mining/start` - بدء التعدين
- `POST /api/mining/stop` - إيقاف التعدين

### WebSocket

الاتصال بـ `ws://localhost:8080/api/ws` للتحديثات في الوقت الفعلي.

## النشر

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

## المساهمة

المساهمات مرحب بها! يرجى اتباع ممارسات التطوير القياسية:

1. إنشاء فرع للميزة
2. إجراء التغييرات
3. اختبار شامل
4. تقديم للمراجعة

## الترخيص

هذا المشروع مرخص تحت ترخيص MIT - راجع ملف [LICENSE](LICENSE) للتفاصيل.

## التقديرات

- مطوري Bitcoin Core لبروتوكولات التعدين
- مجتمع Go للمكتبات الممتازة
- جميع المساهمين ومستخدمي Otedama

## الدعم

- تحقق من الوثائق في دليل `docs/`
- راجع أمثلة التكوين في `config.example.yaml`
- استشر وثائق API في `/api/docs` أثناء التشغيل

## التبرعات

إذا وجدت Otedama مفيداً، فكر في دعم التطوير:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

دعمك يساعد في صيانة وتحسين Otedama!

---

**⚠️ مهم**: تعدين العملات المشفرة يستهلك موارد حاسوبية وكهرباء كبيرة. يرجى فهم التكاليف والتأثير البيئي قبل بدء التعدين.