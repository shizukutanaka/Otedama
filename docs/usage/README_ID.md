# Otedama - Panduan Penggunaan Perangkat Lunak Pool Mining P2P

## Daftar Isi
1. [Instalasi](#instalasi)
2. [Konfigurasi](#konfigurasi)
3. [Menjalankan Otedama](#menjalankan-otedama)
4. [Operasi Mining](#operasi-mining)
5. [Manajemen Pool](#manajemen-pool)
6. [Pemantauan](#pemantauan)
7. [Pemecahan Masalah](#pemecahan-masalah)

## Instalasi

### Persyaratan Sistem
- Sistem Operasi: Linux, Windows, macOS
- RAM: Minimum 4GB, Disarankan 8GB+
- Penyimpanan: 50GB+ ruang kosong
- Jaringan: Koneksi internet stabil

### Instalasi Cepat
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfigurasi
Buat `config.yaml` dengan algoritma, thread, URL pool, alamat dompet.

## Menjalankan Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ALAMAT --worker worker1
```

## Dukungan
- GitHub: https://github.com/otedama/otedama
