# Otedama - एंटरप्राइज़ P2P माइनिंग पूल और माइनिंग सॉफ़्टवेयर

**संस्करण**: 2.1.6  
**लाइसेंस**: MIT  
**Go संस्करण**: 1.21+  
**आर्किटेक्चर**: P2P पूल समर्थन के साथ माइक्रोसर्विसेज  
**रिलीज़ की तारीख**: 6 अगस्त 2025

Otedama एक एंटरप्राइज़-ग्रेड P2P माइनिंग पूल और माइनिंग सॉफ़्टवेयर है जो अधिकतम दक्षता और विश्वसनीयता के लिए डिज़ाइन किया गया है। John Carmack (प्रदर्शन), Robert C. Martin (स्वच्छ आर्किटेक्चर) और Rob Pike (सरलता) के डिज़ाइन सिद्धांतों के अनुसार निर्मित, यह राष्ट्रीय स्केलेबिलिटी के साथ व्यापक CPU/GPU/ASIC माइनिंग का समर्थन करता है।

## आर्किटेक्चर

### P2P माइनिंग पूल
- **वितरित पूल प्रबंधन**: स्वचालित फेलओवर के साथ वितरित माइनिंग पूल
- **पुरस्कार वितरण**: मल्टी-करेंसी समर्थन के साथ उन्नत PPS/PPLNS एल्गोरिदम
- **फेडरेशन प्रोटोकॉल**: बढ़ी हुई लचीलता के लिए इंटर-पूल संचार
- **राष्ट्रीय स्तर की निगरानी**: सरकारी तैनाती के लिए उपयुक्त एंटरप्राइज़ निगरानी

### माइनिंग विशेषताएं
- **मल्टी-एल्गोरिदम**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **सार्वभौमिक हार्डवेयर**: CPU, GPU (CUDA/OpenCL), ASIC के लिए अनुकूलित
- **उन्नत Stratum**: हाई-परफॉर्मेंस माइनर्स के लिए एक्सटेंशन के साथ पूर्ण v1/v2 समर्थन
- **Zero-Copy अनुकूलन**: कैश-अवेयर डेटा संरचनाएं और NUMA-अवेयर मेमोरी

### एंटरप्राइज़ विशेषताएं
- **उत्पादन तैयार**: ऑटो-स्केलिंग के साथ Docker/Kubernetes तैनाती
- **एंटरप्राइज़ सुरक्षा**: DDoS सुरक्षा, दर सीमा, व्यापक ऑडिटिंग
- **उच्च उपलब्धता**: स्वचालित फेलओवर के साथ मल्टी-नोड सेटअप
- **रियल-टाइम एनालिटिक्स**: लाइव डैशबोर्ड एकीकरण के साथ WebSocket API

## आवश्यकताएं

- Go 1.21 या उससे अधिक
- Linux, macOS, Windows
- माइनिंग हार्डवेयर (CPU/GPU/ASIC)
- माइनिंग पूल से नेटवर्क कनेक्शन

## इंस्टॉलेशन

### स्रोत से

```bash
# स्रोत निर्देशिका में बिल्ड करें
cd Otedama

# बाइनरी बिल्ड करें
make build

# सिस्टम में इंस्टॉल करें
make install
```

### Go Build का उपयोग

```bash
go build ./cmd/otedama
```

### Docker उत्पादन

```bash
# उत्पादन तैनाती
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# पूर्ण स्टैक तैनात करें
kubectl apply -f k8s/
```

## त्वरित शुरुआत

### 1. कॉन्फ़िगरेशन

```yaml
# P2P पूल समर्थन के साथ उत्पादन कॉन्फ़िगरेशन
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # स्वचालित पहचान
    priority: "normal"
  
  gpu:
    devices: [] # सभी डिवाइसेस को स्वचालित रूप से पहचानें
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # स्वचालित खोज
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

### 2. तैनाती विकल्प

```bash
# विकास
./otedama serve --config config.yaml

# उत्पादन Docker
docker-compose -f docker-compose.production.yml up -d

# एंटरप्राइज़ Kubernetes
kubectl apply -f k8s/

# मैन्युअल उत्पादन तैनाती
sudo ./scripts/production-deploy.sh
```

### 3. प्रदर्शन निगरानी

```bash
# स्थिति जांचें
./otedama status

# लॉग देखें
tail -f logs/otedama.log

# API एंडपॉइंट
curl http://localhost:8080/api/status
```

## प्रदर्शन

Otedama अधिकतम दक्षता के लिए अनुकूलित है:

- **मेमोरी उपयोग**: न्यूनतम मेमोरी फुटप्रिंट के लिए अनुकूलित
- **बाइनरी आकार**: कॉम्पैक्ट आकार (~15MB)
- **स्टार्टअप समय**: <500ms
- **CPU ओवरहेड**: निगरानी के लिए <1%

## API संदर्भ

### REST एंडपॉइंट्स

- `GET /api/status` - माइनिंग स्थिति
- `GET /api/stats` - विस्तृत आंकड़े
- `GET /api/workers` - वर्कर जानकारी
- `POST /api/mining/start` - माइनिंग शुरू करें
- `POST /api/mining/stop` - माइनिंग बंद करें

### WebSocket

रियल-टाइम अपडेट के लिए `ws://localhost:8080/api/ws` से कनेक्ट करें।

## तैनाती

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

## योगदान

योगदान का स्वागत है! कृपया मानक विकास प्रथाओं का पालन करें:

1. फीचर ब्रांच बनाएं
2. परिवर्तन करें
3. पूरी तरह से परीक्षण करें
4. समीक्षा के लिए सबमिट करें

## लाइसेंस

यह प्रोजेक्ट MIT लाइसेंस के तहत लाइसेंसीकृत है - विवरण के लिए [LICENSE](LICENSE) फाइल देखें।

## आभार

- माइनिंग प्रोटोकॉल के लिए Bitcoin Core डेवलपर्स
- उत्कृष्ट लाइब्रेरी के लिए Go कम्युनिटी
- सभी Otedama योगदानकर्ता और उपयोगकर्ता

## समर्थन

- `docs/` निर्देशिका में दस्तावेज़ देखें
- `config.example.yaml` में कॉन्फ़िगरेशन उदाहरण समीक्षा करें
- चलने के दौरान `/api/docs` पर API दस्तावेज़ देखें

## दान

यदि आपको Otedama उपयोगी लगता है, तो विकास का समर्थन करने पर विचार करें:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

आपका समर्थन Otedama को बनाए रखने और सुधारने में मदद करता है!

---

**⚠️ महत्वपूर्ण**: क्रिप्टोकरेंसी माइनिंग महत्वपूर्ण कम्प्यूटेशनल संसाधन और बिजली की खपत करती है। माइनिंग शुरू करने से पहले कृपया लागत और पर्यावरणीय प्रभाव को समझें।