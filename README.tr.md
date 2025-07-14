# Otedama v0.5

**Tam Otomatik P2P Madencilik Havuzu + DEX + DeFi Platformu**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md)

---

## Genel Bakış

Otedama, tam otomatik ticari seviye P2P madencilik havuzu, DEX ve DeFi platformudur. John Carmack (performans öncelikli), Robert C. Martin (temiz mimari) ve Rob Pike (basitlik) tasarım felsefeleri doğrultusunda geliştirilmiştir.

### Ana Özellikler

- **Tam Otomatik İşletim** - Manuel müdahale gerektirmez
- **Değiştirilemez Ücret Sistemi** - Değiştirilemez %1,5 BTC otomatik tahsilatı
- **Çoklu Algoritma Desteği** - CPU/GPU/ASIC uyumlu
- **Birleşik DEX** - V2 AMM + V3 Yoğunlaştırılmış Likidite
- **Otomatik Ödeme** - Saatlik otomatik madenci ödül ödemeleri
- **DeFi Özellikleri** - Otomatik tasfiye, yönetişim, köprüler
- **Kurumsal Sınıf** - 10.000+ madenci desteği

### İşletim Otomasyon Özellikleri

1. **Otomatik Ücret Tahsilatı**
   - BTC Adresi: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (değiştirilemez)
   - Havuz Ücreti: %0 (kaldırıldı)
   - İşletim Ücreti: %1,5 (değiştirilemez)
   - Toplam Ücret: %1,5 (sadece işletim ücreti)
   - Tahsilat Sıklığı: Her 5 dakikada bir
   - Tüm para birimlerini otomatik olarak BTC'ye dönüştürme

2. **Otomatik Madencilik Ödül Dağıtımı**
   - Saatlik yürütme
   - Otomatik havuz ücreti kesintisi
   - Minimum ödeme tutarına ulaşıldığında otomatik gönderim
   - Otomatik işlem kaydı

3. **Tam Otomatik DEX/DeFi**
   - Likidite havuzlarının otomatik yeniden dengelenmesi
   - Otomatik tasfiye (%85 LTV)
   - Yönetişim önerilerinin otomatik yürütülmesi
   - Çapraz zincir köprülerinin otomatik aktarımı

---

## Sistem Gereksinimleri

### Minimum Gereksinimler
- Node.js 18+
- RAM: 2GB
- Depolama: 10GB SSD
- Ağ: 100Mbps

### Önerilen Gereksinimler
- İşlemci: 8+ çekirdek
- RAM: 8GB+
- Depolama: 100GB NVMe SSD
- Ağ: 1Gbps

---

## Kurulum

### 1. Temel Kurulum

```bash
# Depoyu klonlayın
git clone https://github.com/otedama/otedama.git
cd otedama

# Bağımlılıkları yükleyin
npm install

# Başlat
npm start
```

### 2. Docker Kurulumu

```bash
# Docker Compose ile başlat
docker-compose up -d

# Günlükleri kontrol et
docker-compose logs -f otedama
```

### 3. Tek Tıkla Kurulum

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

## Yapılandırma

### Temel Yapılandırma

`otedama.json` dosyasını düzenleyin:

```json
{
  "pool": {
    "name": "Havuz Adınız",
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
    "walletAddress": "Cüzdan Adresiniz"
  }
}
```

### Komut Satırı Yapılandırması

```bash
# Temel başlatma
node index.js --wallet RYourWalletAddress --currency RVN

# Yüksek performans
node index.js --threads 16 --max-miners 5000 --enable-dex

# Özel portlar
node index.js --api-port 9080 --stratum-port 4444
```

---

## Madenci Bağlantısı

### Bağlantı Bilgileri
- Sunucu: `IP_ADRESİNİZ:3333`
- Kullanıcı adı: `CüzdanAdresi.İşçiAdı`
- Şifre: `x`

### Madencilik Yazılımı Örnekleri

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://IP_ADRESİNİZ:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://IP_ADRESİNİZ:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o IP_ADRESİNİZ:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Desteklenen Para Birimleri

| Para Birimi | Algoritma | Min. Ödeme | Ücret |
|-------------|-----------|------------|-------|
| BTC | SHA256 | 0,001 BTC | %1,5 |
| RVN | KawPow | 100 RVN | %1,5 |
| XMR | RandomX | 0,1 XMR | %1,5 |
| ETC | Ethash | 1 ETC | %1,5 |
| LTC | Scrypt | 0,1 LTC | %1,5 |
| DOGE | Scrypt | 100 DOGE | %1,5 |
| KAS | kHeavyHash | 100 KAS | %1,5 |
| ERGO | Autolykos | 1 ERGO | %1,5 |

Tüm para birimleri: %1,5 sabit ücret (sadece işletim ücreti) - değiştirilemez

---

## API

### REST Uç Noktaları

```bash
# Havuz istatistikleri
GET /api/stats

# Ücret tahsilat durumu
GET /api/fees

# Madenci bilgileri
GET /api/miners/{minerId}

# DEX fiyatları
GET /api/dex/prices

# Sistem sağlığı
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

## İşletmeci Bilgileri

### Gelir Yapısı

1. **İşletim Ücreti**: %1,5 sabit (değiştirilemez)
2. **DEX Ücreti**: %0,3 (likidite sağlayıcılara dağıtılır)
3. **DeFi Ücreti**: Kredi faizinin bir kısmı

### Otomatikleştirilmiş Görevler

- **Her 5 dakikada**: İşletim ücreti BTC dönüşümü ve tahsilatı
- **Her 10 dakikada**: DEX havuz yeniden dengeleme
- **Her 30 dakikada**: DeFi tasfiye kontrolü
- **Saatlik**: Otomatik madenci ödemeleri
- **Her 24 saatte**: Veritabanı optimizasyonu ve yedekleme

### İzleme

Kontrol Paneli: `http://localhost:8080`

Ana Metrikler:
- Aktif madenciler
- Hash oranı
- Ücret geliri
- DEX hacmi
- Sistem kaynakları

---

## Güvenlik

### Uygulanan Korumalar

1. **DDoS Koruması**
   - Çok katmanlı hız sınırlama
   - Uyarlanabilir eşikler
   - Meydan okuma-yanıt

2. **Kimlik Doğrulama Sistemi**
   - JWT + MFA
   - Rol tabanlı erişim kontrolü
   - API anahtar yönetimi

3. **Müdahale Önleme**
   - Değiştirilemez işletim ücreti adresi
   - Sistem bütünlüğü kontrolleri
   - Denetim günlükleri

---

## Sorun Giderme

### Port Kullanımda
```bash
# Portu kullanan işlemi kontrol et
netstat -tulpn | grep :8080

# İşlemi durdur
kill -9 PID
```

### Bellek Sorunları
```bash
# Node.js bellek sınırını artır
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Hata Ayıklama Modu
```bash
DEBUG=* node index.js
```

---

## Performans Optimizasyonu

### Optimizasyon Özellikleri

- **Veritabanı Toplu İşleme**: %70 daha hızlı
- **Ağ Optimizasyonu**: %40 bant genişliği azaltımı
- **Gelişmiş Önbellekleme**: %85+ isabet oranı
- **Sıfır Kopyalama İşlemleri**: Verimli madencilik işleme

### Karşılaştırma Sonuçları

```bash
# Karşılaştırma çalıştır
npm run benchmark

# Sonuçlar (8 çekirdek, 16GB RAM):
- Veritabanı: 50.000+ işlem/saniye
- Ağ: 10.000+ mesaj/saniye
- Önbellek isabet oranı: %85+
- Bellek kullanımı: <100MB (temel)
```

---

## Lisans

MIT Lisansı - Ticari kullanıma izin verilir

## Destek

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Otomatik Madenciliğin Geleceği

---