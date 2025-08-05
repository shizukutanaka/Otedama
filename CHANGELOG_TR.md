# Değişiklik Günlüğü

Otedama'nın tüm önemli değişiklikleri bu dosyada belgelenecektir.

Format [Keep a Changelog](https://keepachangelog.com/tr/1.0.0/) temel alınmaktadır,
ve bu proje [Anlamsal Sürümleme](https://semver.org/lang/tr/) kurallarına uymaktadır.

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