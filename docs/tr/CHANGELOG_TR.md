# Değişiklik Günlüğü

Otedama'nın tüm önemli değişiklikleri bu dosyada belgelenecektir.

Format [Keep a Changelog](https://keepachangelog.com/tr/1.0.0/) temel alınmaktadır,
ve bu proje [Anlamsal Sürümleme](https://semver.org/lang/tr/) kurallarına uymaktadır.

## [2.1.6] - 2025-08-06

### Eklendi
- Kontrol listesine göre kapsamlı P2P ve DEX/DeFi implementasyonu
- Kurumsal düzeyde dağıtım altyapısı (Docker, Ansible, Kubernetes)
- P2P ağ sağlığı izleme ve otomatik kurtarma sistemi
- Prometheus metrikleri ve Grafana panolarıyla yapılandırılmış günlükleme
- Gelişmiş güvenlik özellikleri (HSM cüzdan entegrasyonu, akıllı sözleşme koruması)
- Çok faktörlü kimlik doğrulama (TOTP, WebAuthn, Email, SMS)
- Hiyerarşik izinlere sahip rol tabanlı erişim kontrolü (RBAC)
- Web güvenlik implementasyonu (XSS/CSRF koruması, girdi validasyonu)
- Birim, entegrasyon ve E2E testleriyle kapsamlı test framework'ü
- Otomatik dağıtım için GitHub Actions ile CI/CD pipeline'ları
- Komple dokümantasyon paketi (Başlangıç, İzleme, Güvenlik, Performans)
- Yasal belgeler (Hizmet Şartları, Gizlilik Politikası, Kabul Edilebilir Kullanım Politikası)
- Ölçeklenebilirlik optimizasyonları (sharding, bağlantı havuzu, yük dengeleme)
- Otomatik indeks önerileriyle sorgu optimize edici
- 30 dilde README dosyalarıyla kapsamlı çok dilli destek
- Desteklenen tüm diller için çok dilli CHANGELOG dosyaları
- Tam uluslararasılaştırma altyapısı

### Değiştirildi
- Global dağıtımı destekleyecek dokümantasyon yapısı
- Dile özel dosyaların geliştirilmiş organizasyonu
- Dağıtılmış izleme ile geliştirilmiş izleme sistemi
- Güvenlik ulusal standartlara yükseltildi
- 1M+ eşzamanlı bağlantı için optimized performans

### Düzeltildi
- Kalan tüm derleme hataları
- İçe aktarma döngüsü sorunları tamamen çözüldü
- Bellek optimizasyonu ve çöp toplama ayarlaması
- Ağ gecikmesi optimizasyonu
- Veritabanı sorgu performans iyileştirmeleri

### Güvenlik
- Donanım Güvenlik Modülü (HSM) desteği eklendi
- Akıllı sözleşme güvenlik açığı tarayıcısı implement edildi
- Adaptif hız sınırlama ile geliştirilmiş DDoS koruması
- Kapsamlı denetim günlükleme eklendi
- Zero-knowledge proof kimlik doğrulama hazırlığı implement edildi

## [2.1.4] - 2025-08-20

### Eklendi
- Kurumsal düzeyde P2P madencilik havuzu işlevselliği
- PPS/PPLNS ödül algoritmaları ile çoklu para birimi desteği
- Havuzlar arası iletişim için federasyon protokolü
- Ulusal düzeyde izleme yetenekleri
- Yüksek performans uzantılarına sahip gelişmiş Stratum v1/v2 protokolü
- Geliştirilmiş performans için sıfır kopyalama optimizasyonları
- NUMA farkında bellek tahsisi
- Kapsamlı donanım izleme (CPU/GPU/ASIC)
- Canlı güncellemeler için gerçek zamanlı WebSocket API
- Kurumsal güvenlik özellikleri (DDoS koruması, hız sınırlaması)
- Otomatik ölçeklendirme ile Docker/Kubernetes dağıtımı
- Çok dilli destek (30 dil)

### Değiştirildi
- P2P havuz desteği ile mikroservis mimarisine yükseltildi
- Önbellek farkında veri yapıları ile madencilik motoru geliştirildi
- Doğrulama ile konfigürasyon sistemi iyileştirildi
- Kapsamlı izleme uç noktaları ile API güncellendi
- Kurumsal kullanım için dağıtım kılavuzları modernize edildi

### Düzeltildi
- Madencilik işçilerinde bellek sızıntısı sorunları
- Kripto ve bellek paketlerinde derleme hataları
- Döngüsel içe aktarma bağımlılıkları
- Kod tabanı genelinde yinelenen dosyaların birleştirilmesi

### Güvenlik
- Kapsamlı DDoS koruması eklendi
- Kurumsal düzeyde kimlik doğrulama uygulandı
- Geliştirilmiş girdi doğrulama ve temizleme
- Güvenlik denetim günlüğü eklendi

## [2.1.3] - 2025-08-15

### Eklendi
- Büyük kod optimizasyonu ve temizleme
- Geliştirilmiş hata işleme kalıpları
- Geliştirilmiş günlükleme sistemi

### Değiştirildi
- Basitleştirilmiş kripto uygulaması
- Birleştirilmiş yinelenen işlevsellik
- Optimize edilmiş bellek kullanımı

### Düzeltildi
- Çeşitli küçük hatalar ve sorunlar

## [2.1.2] - 2025-08-10

### Eklendi
- İlk kıyaslama paketi
- Performans izleme araçları

### Değiştirildi
- Bağımlılıklar güncellendi
- Belgeler iyileştirildi

### Düzeltildi
- Konfigürasyon yükleme sorunları

## [2.1.1] - 2025-08-05

### Eklendi
- Temel madencilik işlevselliği
- İlk API uygulaması

### Değiştirildi
- Proje yapısı iyileştirmeleri

### Düzeltildi
- Derleme sistemi sorunları

## [2.1.0] - 2025-08-01

### Eklendi
- Otedama'nın ilk sürümü
- Temel CPU madencilik desteği
- Basit konfigürasyon sistemi
- REST API uç noktaları