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
- GitHub: https://github.com/otedama/otedama
