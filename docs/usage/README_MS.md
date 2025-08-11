# Otedama - Panduan Pengguna Perisian Pool Perlombongan P2P

## Kandungan
1. [Pemasangan](#pemasangan)
2. [Konfigurasi](#konfigurasi)
3. [Menjalankan Otedama](#menjalankan-otedama)
4. [Operasi Perlombongan](#operasi-perlombongan)
5. [Pengurusan Pool](#pengurusan-pool)
6. [Pemantauan](#pemantauan)
7. [Penyelesaian Masalah](#penyelesaian-masalah)

## Pemasangan

### Keperluan Sistem
- Sistem Operasi: Linux, Windows, macOS
- RAM: Minimum 4GB, Disyorkan 8GB+
- Storan: 50GB+ ruang kosong
- Rangkaian: Sambungan internet yang stabil

### Pemasangan Pantas
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfigurasi
Cipta `config.yaml` dengan algoritma, thread, URL pool, alamat dompet.

## Menjalankan Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ALAMAT --worker worker1
```

## Sokongan
- GitHub: https://github.com/otedama/otedama
