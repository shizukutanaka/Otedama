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
- GitHub: https://github.com/otedama/otedama
