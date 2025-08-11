# Otedama - P2P Madencilik Havuzu Yazılımı Kullanım Kılavuzu

## İçindekiler
1. [Kurulum](#kurulum)
2. [Yapılandırma](#yapılandırma)
3. [Otedama Çalıştırma](#otedama-çalıştırma)
4. [Madencilik İşlemleri](#madencilik-işlemleri)
5. [Havuz Yönetimi](#havuz-yönetimi)
6. [İzleme](#izleme)
7. [Sorun Giderme](#sorun-giderme)

## Kurulum

### Sistem Gereksinimleri
- İşletim Sistemi: Linux, Windows, macOS
- RAM: Minimum 4GB, Önerilen 8GB+
- Depolama: 50GB+ boş alan
- Ağ: Kararlı internet bağlantısı

### Hızlı Kurulum
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Yapılandırma
Algoritma, thread, havuz URL'si, cüzdan adresi ile `config.yaml` oluşturun.

## Otedama Çalıştırma
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRES --worker worker1
```

## Destek
- GitHub: https://github.com/otedama/otedama
