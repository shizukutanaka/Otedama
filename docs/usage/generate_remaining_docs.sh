#!/bin/bash

# Script to generate remaining documentation files
# This creates template files for the remaining languages

cat > README_IT.md << 'EOF'
# Otedama - Guida all'Uso del Software Pool di Mining P2P

## Indice
1. [Installazione](#installazione)
2. [Configurazione](#configurazione)
3. [Eseguire Otedama](#eseguire-otedama)
4. [Operazioni di Mining](#operazioni-di-mining)
5. [Gestione Pool](#gestione-pool)
6. [Monitoraggio](#monitoraggio)
7. [Risoluzione Problemi](#risoluzione-problemi)

## Installazione

### Requisiti di Sistema
- Sistema Operativo: Linux, Windows, macOS
- RAM: Minimo 4GB, Consigliato 8GB+
- Storage: 50GB+ spazio libero
- Rete: Connessione internet stabile

### Installazione Rapida
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Configurazione
Creare `config.yaml` con algoritmo, threads, pool URL, indirizzo wallet.

## Eseguire Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet INDIRIZZO --worker worker1
```

## Supporto
- Documentazione: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_NL.md << 'EOF'
# Otedama - P2P Mining Pool Software Gebruikershandleiding

## Inhoudsopgave
1. [Installatie](#installatie)
2. [Configuratie](#configuratie)
3. [Otedama Uitvoeren](#otedama-uitvoeren)
4. [Mining Operaties](#mining-operaties)
5. [Pool Beheer](#pool-beheer)
6. [Monitoring](#monitoring)
7. [Probleemoplossing](#probleemoplossing)

## Installatie

### Systeemvereisten
- Besturingssysteem: Linux, Windows, macOS
- RAM: Minimum 4GB, Aanbevolen 8GB+
- Opslag: 50GB+ vrije ruimte
- Netwerk: Stabiele internetverbinding

### Snelle Installatie
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Configuratie
Maak `config.yaml` met algoritme, threads, pool URL, wallet adres.

## Otedama Uitvoeren
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRES --worker worker1
```

## Ondersteuning
- Documentatie: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_PL.md << 'EOF'
# Otedama - Przewodnik Użytkownika Oprogramowania P2P Mining Pool

## Spis Treści
1. [Instalacja](#instalacja)
2. [Konfiguracja](#konfiguracja)
3. [Uruchamianie Otedama](#uruchamianie-otedama)
4. [Operacje Wydobywcze](#operacje-wydobywcze)
5. [Zarządzanie Poolem](#zarządzanie-poolem)
6. [Monitorowanie](#monitorowanie)
7. [Rozwiązywanie Problemów](#rozwiązywanie-problemów)

## Instalacja

### Wymagania Systemowe
- System Operacyjny: Linux, Windows, macOS
- RAM: Minimum 4GB, Zalecane 8GB+
- Pamięć: 50GB+ wolnego miejsca
- Sieć: Stabilne połączenie internetowe

### Szybka Instalacja
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfiguracja
Utwórz `config.yaml` z algorytmem, wątkami, URL pool, adresem portfela.

## Uruchamianie Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRES --worker worker1
```

## Wsparcie
- Dokumentacja: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_UK.md << 'EOF'
# Otedama - Керівництво користувача P2P майнінг-пулу

## Зміст
1. [Встановлення](#встановлення)
2. [Конфігурація](#конфігурація)
3. [Запуск Otedama](#запуск-otedama)
4. [Операції майнінгу](#операції-майнінгу)
5. [Управління пулом](#управління-пулом)
6. [Моніторинг](#моніторинг)
7. [Усунення несправностей](#усунення-несправностей)

## Встановлення

### Системні вимоги
- Операційна система: Linux, Windows, macOS
- ОЗП: Мінімум 4ГБ, Рекомендовано 8ГБ+
- Сховище: 50ГБ+ вільного місця
- Мережа: Стабільне інтернет-з'єднання

### Швидке встановлення
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Конфігурація
Створіть `config.yaml` з алгоритмом, потоками, URL пулу, адресою гаманця.

## Запуск Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet АДРЕСА --worker worker1
```

## Підтримка
- Документація: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_KO.md << 'EOF'
# Otedama - P2P 마이닝 풀 소프트웨어 사용 가이드

## 목차
1. [설치](#설치)
2. [구성](#구성)
3. [Otedama 실행](#otedama-실행)
4. [마이닝 작업](#마이닝-작업)
5. [풀 관리](#풀-관리)
6. [모니터링](#모니터링)
7. [문제 해결](#문제-해결)

## 설치

### 시스템 요구사항
- 운영체제: Linux, Windows, macOS
- RAM: 최소 4GB, 권장 8GB+
- 저장소: 50GB+ 여유 공간
- 네트워크: 안정적인 인터넷 연결

### 빠른 설치
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## 구성
알고리즘, 스레드, 풀 URL, 지갑 주소로 `config.yaml` 생성.

## Otedama 실행
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet 주소 --worker worker1
```

## 지원
- 문서: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_HI.md << 'EOF'
# Otedama - P2P माइनिंग पूल सॉफ्टवेयर उपयोगकर्ता गाइड

## विषय सूची
1. [स्थापना](#स्थापना)
2. [कॉन्फ़िगरेशन](#कॉन्फ़िगरेशन)
3. [Otedama चलाना](#otedama-चलाना)
4. [माइनिंग संचालन](#माइनिंग-संचालन)
5. [पूल प्रबंधन](#पूल-प्रबंधन)
6. [निगरानी](#निगरानी)
7. [समस्या निवारण](#समस्या-निवारण)

## स्थापना

### सिस्टम आवश्यकताएं
- ऑपरेटिंग सिस्टम: Linux, Windows, macOS
- RAM: न्यूनतम 4GB, अनुशंसित 8GB+
- भंडारण: 50GB+ मुक्त स्थान
- नेटवर्क: स्थिर इंटरनेट कनेक्शन

### त्वरित स्थापना
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## कॉन्फ़िगरेशन
एल्गोरिथम, थ्रेड्स, पूल URL, वॉलेट पता के साथ `config.yaml` बनाएं।

## Otedama चलाना
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet पता --worker worker1
```

## समर्थन
- दस्तावेज़: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_TH.md << 'EOF'
# Otedama - คู่มือการใช้งานซอฟต์แวร์ Mining Pool แบบ P2P

## สารบัญ
1. [การติดตั้ง](#การติดตั้ง)
2. [การกำหนดค่า](#การกำหนดค่า)
3. [การรัน Otedama](#การรัน-otedama)
4. [การดำเนินการขุด](#การดำเนินการขุด)
5. [การจัดการพูล](#การจัดการพูล)
6. [การตรวจสอบ](#การตรวจสอบ)
7. [การแก้ไขปัญหา](#การแก้ไขปัญหา)

## การติดตั้ง

### ความต้องการของระบบ
- ระบบปฏิบัติการ: Linux, Windows, macOS
- RAM: ขั้นต่ำ 4GB, แนะนำ 8GB+
- พื้นที่จัดเก็บ: 50GB+ พื้นที่ว่าง
- เครือข่าย: การเชื่อมต่ออินเทอร์เน็ตที่เสถียร

### การติดตั้งด่วน
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## การกำหนดค่า
สร้าง `config.yaml` พร้อมอัลกอริทึม, เธรด, URL พูล, ที่อยู่กระเป๋าเงิน

## การรัน Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ที่อยู่ --worker worker1
```

## การสนับสนุน
- เอกสาร: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_VI.md << 'EOF'
# Otedama - Hướng dẫn Sử dụng Phần mềm Pool Khai thác P2P

## Mục lục
1. [Cài đặt](#cài-đặt)
2. [Cấu hình](#cấu-hình)
3. [Chạy Otedama](#chạy-otedama)
4. [Hoạt động Khai thác](#hoạt-động-khai-thác)
5. [Quản lý Pool](#quản-lý-pool)
6. [Giám sát](#giám-sát)
7. [Khắc phục Sự cố](#khắc-phục-sự-cố)

## Cài đặt

### Yêu cầu Hệ thống
- Hệ điều hành: Linux, Windows, macOS
- RAM: Tối thiểu 4GB, Khuyến nghị 8GB+
- Lưu trữ: 50GB+ dung lượng trống
- Mạng: Kết nối internet ổn định

### Cài đặt Nhanh
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Cấu hình
Tạo `config.yaml` với thuật toán, luồng, URL pool, địa chỉ ví.

## Chạy Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ĐỊA_CHỈ --worker worker1
```

## Hỗ trợ
- Tài liệu: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_ID.md << 'EOF'
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
- Dokumentasi: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_MS.md << 'EOF'
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
- Dokumentasi: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_AR.md << 'EOF'
# Otedama - دليل استخدام برنامج تجمع التعدين P2P

## المحتويات
1. [التثبيت](#التثبيت)
2. [التكوين](#التكوين)
3. [تشغيل Otedama](#تشغيل-otedama)
4. [عمليات التعدين](#عمليات-التعدين)
5. [إدارة التجمع](#إدارة-التجمع)
6. [المراقبة](#المراقبة)
7. [استكشاف الأخطاء](#استكشاف-الأخطاء)

## التثبيت

### متطلبات النظام
- نظام التشغيل: Linux، Windows، macOS
- الذاكرة: 4GB كحد أدنى، 8GB+ موصى به
- التخزين: 50GB+ مساحة حرة
- الشبكة: اتصال إنترنت مستقر

### التثبيت السريع
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## التكوين
إنشاء `config.yaml` مع الخوارزمية، الخيوط، عنوان URL للتجمع، عنوان المحفظة.

## تشغيل Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet العنوان --worker worker1
```

## الدعم
- التوثيق: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_TR.md << 'EOF'
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
- Dokümantasyon: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_HE.md << 'EOF'
# Otedama - מדריך שימוש בתוכנת בריכת כרייה P2P

## תוכן עניינים
1. [התקנה](#התקנה)
2. [הגדרות](#הגדרות)
3. [הפעלת Otedama](#הפעלת-otedama)
4. [פעולות כרייה](#פעולות-כרייה)
5. [ניהול הבריכה](#ניהול-הבריכה)
6. [ניטור](#ניטור)
7. [פתרון בעיות](#פתרון-בעיות)

## התקנה

### דרישות מערכת
- מערכת הפעלה: Linux, Windows, macOS
- זיכרון: מינימום 4GB, מומלץ 8GB+
- אחסון: 50GB+ שטח פנוי
- רשת: חיבור אינטרנט יציב

### התקנה מהירה
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## הגדרות
צור `config.yaml` עם אלגוריתם, תהליכונים, כתובת URL של הבריכה, כתובת ארנק.

## הפעלת Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet כתובת --worker worker1
```

## תמיכה
- תיעוד: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_FA.md << 'EOF'
# Otedama - راهنمای استفاده از نرم‌افزار استخر استخراج P2P

## فهرست مطالب
1. [نصب](#نصب)
2. [پیکربندی](#پیکربندی)
3. [اجرای Otedama](#اجرای-otedama)
4. [عملیات استخراج](#عملیات-استخراج)
5. [مدیریت استخر](#مدیریت-استخر)
6. [نظارت](#نظارت)
7. [عیب‌یابی](#عیب‌یابی)

## نصب

### نیازمندی‌های سیستم
- سیستم عامل: Linux، Windows، macOS
- حافظه: حداقل 4GB، توصیه شده 8GB+
- فضای ذخیره‌سازی: 50GB+ فضای آزاد
- شبکه: اتصال اینترنت پایدار

### نصب سریع
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## پیکربندی
ایجاد `config.yaml` با الگوریتم، رشته‌ها، آدرس URL استخر، آدرس کیف پول.

## اجرای Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet آدرس --worker worker1
```

## پشتیبانی
- مستندات: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_SW.md << 'EOF'
# Otedama - Mwongozo wa Matumizi ya Programu ya Dimbwi la Uchimbaji P2P

## Yaliyomo
1. [Ufungaji](#ufungaji)
2. [Usanidi](#usanidi)
3. [Kuendesha Otedama](#kuendesha-otedama)
4. [Shughuli za Uchimbaji](#shughuli-za-uchimbaji)
5. [Usimamizi wa Dimbwi](#usimamizi-wa-dimbwi)
6. [Ufuatiliaji](#ufuatiliaji)
7. [Utatuzi wa Matatizo](#utatuzi-wa-matatizo)

## Ufungaji

### Mahitaji ya Mfumo
- Mfumo wa Uendeshaji: Linux, Windows, macOS
- RAM: Kiwango cha chini 4GB, Kinapendekezwa 8GB+
- Hifadhi: 50GB+ nafasi tupu
- Mtandao: Muunganisho thabiti wa intaneti

### Ufungaji wa Haraka
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Usanidi
Unda `config.yaml` na algorithm, nyuzi, URL ya dimbwi, anwani ya mkoba.

## Kuendesha Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ANWANI --worker worker1
```

## Msaada
- Nyaraka: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_SV.md << 'EOF'
# Otedama - P2P Mining Pool Programvara Användarguide

## Innehållsförteckning
1. [Installation](#installation)
2. [Konfiguration](#konfiguration)
3. [Köra Otedama](#köra-otedama)
4. [Mining-operationer](#mining-operationer)
5. [Pool-hantering](#pool-hantering)
6. [Övervakning](#övervakning)
7. [Felsökning](#felsökning)

## Installation

### Systemkrav
- Operativsystem: Linux, Windows, macOS
- RAM: Minimum 4GB, Rekommenderat 8GB+
- Lagring: 50GB+ ledigt utrymme
- Nätverk: Stabil internetanslutning

### Snabbinstallation
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfiguration
Skapa `config.yaml` med algoritm, trådar, pool-URL, plånboksadress.

## Köra Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRESS --worker worker1
```

## Support
- Dokumentation: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_NO.md << 'EOF'
# Otedama - P2P Mining Pool Programvare Brukerveiledning

## Innholdsfortegnelse
1. [Installasjon](#installasjon)
2. [Konfigurasjon](#konfigurasjon)
3. [Kjøre Otedama](#kjøre-otedama)
4. [Mining-operasjoner](#mining-operasjoner)
5. [Pool-administrasjon](#pool-administrasjon)
6. [Overvåking](#overvåking)
7. [Feilsøking](#feilsøking)

## Installasjon

### Systemkrav
- Operativsystem: Linux, Windows, macOS
- RAM: Minimum 4GB, Anbefalt 8GB+
- Lagring: 50GB+ ledig plass
- Nettverk: Stabil internettforbindelse

### Rask Installasjon
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfigurasjon
Opprett `config.yaml` med algoritme, tråder, pool-URL, lommebokadresse.

## Kjøre Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRESSE --worker worker1
```

## Støtte
- Dokumentasjon: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_DA.md << 'EOF'
# Otedama - P2P Mining Pool Software Brugervejledning

## Indholdsfortegnelse
1. [Installation](#installation)
2. [Konfiguration](#konfiguration)
3. [Kør Otedama](#kør-otedama)
4. [Mining-operationer](#mining-operationer)
5. [Pool-administration](#pool-administration)
6. [Overvågning](#overvågning)
7. [Fejlfinding](#fejlfinding)

## Installation

### Systemkrav
- Operativsystem: Linux, Windows, macOS
- RAM: Minimum 4GB, Anbefalet 8GB+
- Lagerplads: 50GB+ ledig plads
- Netværk: Stabil internetforbindelse

### Hurtig Installation
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfiguration
Opret `config.yaml` med algoritme, tråde, pool-URL, tegnebogsadresse.

## Kør Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRESSE --worker worker1
```

## Support
- Dokumentation: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_FI.md << 'EOF'
# Otedama - P2P Louhintapoolin Ohjelmisto Käyttöopas

## Sisällysluettelo
1. [Asennus](#asennus)
2. [Konfigurointi](#konfigurointi)
3. [Otedaman Käynnistys](#otedaman-käynnistys)
4. [Louhintaoperaatiot](#louhintaoperaatiot)
5. [Poolin Hallinta](#poolin-hallinta)
6. [Valvonta](#valvonta)
7. [Vianmääritys](#vianmääritys)

## Asennus

### Järjestelmävaatimukset
- Käyttöjärjestelmä: Linux, Windows, macOS
- RAM: Vähintään 4GB, Suositus 8GB+
- Tallennustila: 50GB+ vapaata tilaa
- Verkko: Vakaa internetyhteys

### Pika-asennus
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfigurointi
Luo `config.yaml` algoritmilla, säikeillä, pool-URL:lla, lompakko-osoitteella.

## Otedaman Käynnistys
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet OSOITE --worker worker1
```

## Tuki
- Dokumentaatio: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_EL.md << 'EOF'
# Otedama - Οδηγός Χρήσης Λογισμικού P2P Mining Pool

## Περιεχόμενα
1. [Εγκατάσταση](#εγκατάσταση)
2. [Διαμόρφωση](#διαμόρφωση)
3. [Εκτέλεση Otedama](#εκτέλεση-otedama)
4. [Λειτουργίες Εξόρυξης](#λειτουργίες-εξόρυξης)
5. [Διαχείριση Pool](#διαχείριση-pool)
6. [Παρακολούθηση](#παρακολούθηση)
7. [Αντιμετώπιση Προβλημάτων](#αντιμετώπιση-προβλημάτων)

## Εγκατάσταση

### Απαιτήσεις Συστήματος
- Λειτουργικό Σύστημα: Linux, Windows, macOS
- RAM: Ελάχιστο 4GB, Συνιστώμενο 8GB+
- Αποθήκευση: 50GB+ ελεύθερος χώρος
- Δίκτυο: Σταθερή σύνδεση internet

### Γρήγορη Εγκατάσταση
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Διαμόρφωση
Δημιουργήστε `config.yaml` με αλγόριθμο, νήματα, URL pool, διεύθυνση πορτοφολιού.

## Εκτέλεση Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ΔΙΕΥΘΥΝΣΗ --worker worker1
```

## Υποστήριξη
- Τεκμηρίωση: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_CS.md << 'EOF'
# Otedama - Uživatelská Příručka P2P Mining Pool Software

## Obsah
1. [Instalace](#instalace)
2. [Konfigurace](#konfigurace)
3. [Spuštění Otedama](#spuštění-otedama)
4. [Těžební Operace](#těžební-operace)
5. [Správa Poolu](#správa-poolu)
6. [Monitorování](#monitorování)
7. [Řešení Problémů](#řešení-problémů)

## Instalace

### Systémové Požadavky
- Operační systém: Linux, Windows, macOS
- RAM: Minimum 4GB, Doporučeno 8GB+
- Úložiště: 50GB+ volného místa
- Síť: Stabilní internetové připojení

### Rychlá Instalace
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfigurace
Vytvořte `config.yaml` s algoritmem, vlákny, URL poolu, adresou peněženky.

## Spuštění Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRESA --worker worker1
```

## Podpora
- Dokumentace: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

cat > README_RO.md << 'EOF'
# Otedama - Ghid de Utilizare Software Pool de Minerit P2P

## Cuprins
1. [Instalare](#instalare)
2. [Configurare](#configurare)
3. [Rularea Otedama](#rularea-otedama)
4. [Operațiuni de Minerit](#operațiuni-de-minerit)
5. [Gestionarea Pool-ului](#gestionarea-pool-ului)
6. [Monitorizare](#monitorizare)
7. [Depanare](#depanare)

## Instalare

### Cerințe de Sistem
- Sistem de Operare: Linux, Windows, macOS
- RAM: Minim 4GB, Recomandat 8GB+
- Stocare: 50GB+ spațiu liber
- Rețea: Conexiune stabilă la internet

### Instalare Rapidă
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Configurare
Creați `config.yaml` cu algoritm, fire de execuție, URL pool, adresă portofel.

## Rularea Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRESĂ --worker worker1
```

## Suport
- Documentație: https://docs.otedama.io
- GitHub: https://github.com/otedama/otedama
EOF

echo "Documentation files created successfully!"
chmod +x generate_remaining_docs.sh