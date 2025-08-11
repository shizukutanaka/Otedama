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
- GitHub: https://github.com/otedama/otedama
