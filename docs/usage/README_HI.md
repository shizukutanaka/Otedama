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
- GitHub: https://github.com/otedama/otedama
