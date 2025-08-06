# Otedama - พูลขุดเหรียญ P2P และซอฟต์แวร์ขุดเหรียญระดับองค์กร

**เวอร์ชัน**: 2.1.5  
**ใบอนุญาต**: MIT  
**เวอร์ชัน Go**: 1.21+  
**สถาปัตยกรรม**: ไมโครเซอร์วิสพร้อมการสนับสนุนพูล P2P  
**วันที่เผยแพร่**: 6 สิงหาคม 2025

Otedama เป็นพูลขุดเหรียญ P2P และซอฟต์แวร์ขุดเหรียญระดับองค์กรที่ออกแบบมาเพื่อประสิทธิภาพสูงสุดและความน่าเชื่อถือ สร้างขึ้นตามหลักการออกแบบของ John Carmack (ประสิทธิภาพ), Robert C. Martin (สถาปัตยกรรมที่สะอาด) และ Rob Pike (ความเรียบง่าย) รองรับการขุดเหรียญ CPU/GPU/ASIC อย่างครอบคลุมพร้อมความสามารถในการขยายระดับประเทศ

## สถาปัตยกรรม

### พูลขุดเหรียญ P2P
- **การจัดการพูลแบบกระจาย**: พูลขุดเหรียญแบบกระจายพร้อม failover อัตโนมัติ
- **การแจกจ่ายรางวัล**: อัลกอริทึม PPS/PPLNS ขั้นสูงพร้อมการสนับสนุนหลายสกุลเงิน
- **โปรโตคอลสหพันธ์**: การสื่อสารระหว่างพูลเพื่อความยืดหยุ่นที่เพิ่มขึ้น
- **การติดตามระดับประเทศ**: การติดตามระดับองค์กรที่เหมาะสำหรับการปรับใช้ของรัฐบาล

### คุณสมบัติการขุดเหรียญ
- **อัลกอริทึมหลายแบบ**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **ฮาร์ดแวร์สากล**: ปรับให้เหมาะสำหรับ CPU, GPU (CUDA/OpenCL), ASIC
- **Stratum ขั้นสูง**: การสนับสนุน v1/v2 แบบเต็มพร้อมส่วนขยายสำหรับตัวขุดประสิทธิภาพสูง
- **การปรับให้เหมาะ Zero-Copy**: โครงสร้างข้อมูลที่รู้เรื่องแคชและหน่วยความจำที่รู้เรื่อง NUMA

### คุณสมบัติองค์กร
- **พร้อมสำหรับการผลิต**: การปรับใช้ Docker/Kubernetes พร้อมการปรับขนาดอัตโนมัติ
- **ความปลอดภัยองค์กร**: การป้องกัน DDoS, การจำกัดอัตรา, การตรวจสอบที่ครอบคลุม
- **ความพร้อมใช้งานสูง**: การตั้งค่าหลายโหนดพร้อม failover อัตโนมัติ
- **การวิเคราะห์เรียลไทม์**: WebSocket API พร้อมการรวมแดชบอร์ดแบบสด

## ความต้องการ

- Go 1.21 หรือสูงกว่า
- Linux, macOS, Windows
- ฮาร์ดแวร์ขุดเหรียญ (CPU/GPU/ASIC)
- การเชื่อมต่อเครือข่ายไปยังพูลขุดเหรียญ

## การติดตั้ง

### จากซอร์สโค้ด

```bash
# สร้างในไดเรกทอรีซอร์ส
cd Otedama

# สร้างไฟล์ไบนารี
make build

# ติดตั้งในระบบ
make install
```

### ใช้ Go Build

```bash
go build ./cmd/otedama
```

### Docker การผลิต

```bash
# การปรับใช้การผลิต
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# ปรับใช้สแต็คเต็ม
kubectl apply -f k8s/
```

## เริ่มต้นด่วน

### 1. การกำหนดค่า

```yaml
# การกำหนดค่าการผลิตพร้อมการสนับสนุนพูล P2P
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # การตรวจจับอัตโนมัติ
    priority: "normal"
  
  gpu:
    devices: [] # ตรวจจับอุปกรณ์ทั้งหมดอัตโนมัติ
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # การค้นพบอัตโนมัติ
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

### 2. ตัวเลือกการปรับใช้

```bash
# การพัฒนา
./otedama serve --config config.yaml

# Docker การผลิต
docker-compose -f docker-compose.production.yml up -d

# Kubernetes องค์กร
kubectl apply -f k8s/

# การปรับใช้การผลิตแบบแมนนวล
sudo ./scripts/production-deploy.sh
```

### 3. การติดตามประสิทธิภาพ

```bash
# ตรวจสอบสถานะ
./otedama status

# ดูล็อก
tail -f logs/otedama.log

# จุดปลาย API
curl http://localhost:8080/api/status
```

## ประสิทธิภาพ

Otedama ปรับให้เหมาะสำหรับประสิทธิภาพสูงสุด:

- **การใช้หน่วยความจำ**: ปรับให้เหมาะสำหรับรอยเท้าหน่วยความจำขั้นต่ำ
- **ขนาดไบนารี**: ขนาดกะทัดรัด (~15MB)
- **เวลาเริ่มต้น**: <500ms
- **โอเวอร์เฮด CPU**: <1% สำหรับการติดตาม

## อ้างอิง API

### จุดปลาย REST

- `GET /api/status` - สถานะการขุดเหรียญ
- `GET /api/stats` - สถิติโดยละเอียด
- `GET /api/workers` - ข้อมูลคนงาน
- `POST /api/mining/start` - เริ่มการขุดเหรียญ
- `POST /api/mining/stop` - หยุดการขุดเหรียญ

### WebSocket

เชื่อมต่อกับ `ws://localhost:8080/api/ws` สำหรับการอัปเดตเรียลไทม์

## การปรับใช้

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

## การมีส่วนร่วม

ยินดีรับการมีส่วนร่วม! โปรดปฏิบัติตามแนวทางการพัฒนามาตรฐาน:

1. สร้างสาขาคุณสมบัติ
2. ทำการเปลี่ยนแปลง
3. ทดสอบอย่างครอบคลุม
4. ส่งเพื่อตรวจทาน

## ใบอนุญาต

โครงการนี้ได้รับใบอนุญาตภายใต้ใบอนุญาต MIT - โปรดดูไฟล์ [LICENSE](LICENSE) สำหรับรายละเอียด

## กิตติกรรมประกาศ

- นักพัฒนา Bitcoin Core สำหรับโปรโตคอลการขุดเหรียญ
- ชุมชน Go สำหรับไลบรารีที่ยอดเยี่ยม
- ผู้มีส่วนร่วมและผู้ใช้ Otedama ทั้งหมด

## การสนับสนุน

- ตรวจสอบเอกสารในไดเรกทอรี `docs/`
- ตรวจทานตัวอย่างการกำหนดค่าใน `config.example.yaml`
- ดูเอกสาร API ที่ `/api/docs` ขณะทำงาน

## การบริจาค

หากคุณพบว่า Otedama มีประโยชน์ โปรดพิจารณาสนับสนุนการพัฒนา:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

การสนับสนุนของคุณช่วยในการบำรุงรักษาและปรับปรุง Otedama!

---

**⚠️ สำคัญ**: การขุดเหรียญคริปโตใช้ทรัพยากรการคำนวณและไฟฟ้าอย่างมาก โปรดเข้าใจต้นทุนและผลกระทบต่อสิ่งแวดล้อมก่อนเริ่มการขุดเหรียญ