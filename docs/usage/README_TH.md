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
- GitHub: https://github.com/otedama/otedama
