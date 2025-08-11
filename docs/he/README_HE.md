# Otedama - בריכת כרייה P2P ותוכנת כרייה ארגונית

**רישיון**: MIT  
**גרסת Go**: 1.21+  
**ארכיטקטורה**: Microservices עם תמיכה בבריכת P2P  

Otedama היא בריכת כרייה P2P ותוכנת כרייה ברמה ארגונית שתוכננה ליעילות ואמינות מקסימלית. נבנתה לפי עקרונות העיצוב של John Carmack (ביצועים), Robert C. Martin (ארכיטקטורה נקייה) ו-Rob Pike (פשטות), תומכת בכרייה מקיפה של CPU/GPU/ASIC עם יכולת הרחבה ברמה לאומית.

## ארכיטקטורה

### בריכת כרייה P2P
- **ניהול בריכה מבוזר**: בריכת כרייה מבוזרת עם מעבר אוטומטי בעת כשל
- **חלוקת תגמולים**: אלגוריתמי PPS/PPLNS מתקדמים עם תמיכה במטבעות מרובים
- **פרוטוקול פדרציה**: תקשורת בין-בריכות לחוסן משופר
- **ניטור ברמה לאומית**: ניטור ארגוני המתאים לפריסות ממשלתיות

### תכונות כרייה
- **ריבוי אלגוריתמים**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **חומרה אוניברסלית**: מותאם ל-CPU, GPU (CUDA/OpenCL), ASIC
- **Stratum מתקדם**: תמיכה מלאה ב-v1/v2 עם הרחבות לכורים בעלי ביצועים גבוהים
- **אופטימיזציות Zero-Copy**: מבני נתונים מודעי מטמון וזיכרון מודע NUMA

### תכונות ארגוניות
- **מוכן לייצור**: פריסת Docker/Kubernetes עם הרחבה אוטומטית
- **אבטחה ארגונית**: הגנת DDoS, הגבלת קצב, ביקורת מקיפה
- **זמינות גבוהה**: הגדרת ריבוי צמתים עם מעבר אוטומטי בעת כשל
- **אנליטיקה בזמן אמת**: API WebSocket עם אינטגרציית לוח מחוונים חי

## דרישות

- Go 1.21 ומעלה
- Linux, macOS, Windows
- חומרת כרייה (CPU/GPU/ASIC)
- חיבור רשת לבריכת כרייה

## התקנה

### מקוד מקור

```bash
# בנה בתיקיית קוד המקור
cd Otedama

# בנה קובץ בינארי
make build

# התקן במערכת
make install
```

### שימוש ב-Go Build

```bash
go build ./cmd/otedama
```

### Docker ייצור

```bash
# פריסת ייצור
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# פרוס ערימה מלאה
kubectl apply -f k8s/
```

## התחלה מהירה

### 1. תצורה

```yaml
# תצורת ייצור עם תמיכה בבריכת P2P
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # זיהוי אוטומטי
    priority: "normal"
  
  gpu:
    devices: [] # זיהוי אוטומטי של כל ההתקנים
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # גילוי אוטומטי
    poll_interval: 5s

pool:
  enable: true
  address: "0.0.0.0:3333"
  max_connections: 10000
  fee_percentage: 1.0
  rewards:
    system: "PPLNS"
    window: 2h

api:
  enable: true
  address: "0.0.0.0:8080"
  auth:
    enabled: true
    token_expiry: 24h

monitoring:
  metrics:
    enabled: true
    address: "0.0.0.0:9090"
  health:
    enabled: true
    address: "0.0.0.0:8081"
```

### 2. אפשרויות פריסה

```bash
# פיתוח
./otedama serve --config config.yaml

# Docker ייצור
docker-compose -f docker-compose.production.yml up -d

# Kubernetes ארגוני
kubectl apply -f k8s/

# פריסת ייצור ידנית
sudo ./scripts/production-deploy.sh
```

### 3. ניטור ביצועים

```bash
# בדוק סטטוס
./otedama status

# הצג יומנים
tail -f logs/otedama.log

# נקודת קצה API
curl http://localhost:8080/api/status
```

## ביצועים

Otedama מותאמת ליעילות מקסימלית:

- **שימוש בזיכרון**: מותאם לטביעת רגל זיכרון מינימלית
- **גודל בינארי**: גודל קומפקטי (~15MB)
- **זמן הפעלה**: <500ms
- **תקורת CPU**: <1% לניטור

## הפניית API

### נקודות קצה REST

- `GET /api/status` - מצב כרייה
- `GET /api/stats` - סטטיסטיקות מפורטות
- `GET /api/workers` - מידע על עובדים
- `POST /api/mining/start` - התחל כרייה
- `POST /api/mining/stop` - עצור כרייה

### WebSocket

התחבר ל-`ws://localhost:8080/api/ws` לעדכונים בזמן אמת.

## פריסה

### Docker Compose

```yaml
version: '3.8'
services:
  otedama:
    build: .
    volumes:
      - ./config.yaml:/config.yaml
    ports:
      - "8080:8080"
      - "3333:3333"
    restart: unless-stopped
```

### Kubernetes

```bash
kubectl apply -f k8s/
```

## תרומה

תרומות מתקבלות בברכה! אנא עקוב אחר שיטות פיתוח סטנדרטיות:

1. צור ענף תכונה
2. בצע שינויים
3. בדוק ביסודיות
4. שלח לביקורת

## רישיון

פרויקט זה מורשה תחת רישיון MIT - ראה קובץ [LICENSE](LICENSE) לפרטים.

## תודות

- מפתחי Bitcoin Core על פרוטוקולי כרייה
- קהילת Go על ספריות מצוינות
- כל התורמים והמשתמשים של Otedama

## תמיכה

- בדוק תיעוד בתיקיית `docs/`
- סקור דוגמאות תצורה ב-`config.example.yaml`
- היוועץ בתיעוד API ב-`/api/docs` בזמן הפעלה

## תרומות

אם אתה מוצא את Otedama שימושית, שקול לתמוך בפיתוח:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

התמיכה שלך עוזרת לתחזק ולשפר את Otedama!

---

**⚠️ חשוב**: כריית מטבעות קריפטו צורכת משאבי מחשוב וחשמל משמעותיים. אנא הבן את העלויות וההשפעה הסביבתית לפני תחילת הכרייה.