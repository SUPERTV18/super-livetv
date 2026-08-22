# SUPER Live TV - Vercel HLS Proxy

## الاستخدام

بعد نشر المشروع على Vercel:

- `https://YOUR-DOMAIN.vercel.app/SUPER_TV_1.m3u8`
- `https://YOUR-DOMAIN.vercel.app/SUPER_TV_2.m3u8`

## إضافة قناة

افتح `channels.json` وأضف:

```json
"SUPER_TV_3": {
  "url": "https://example.com/channel3/index.m3u8",
  "headers": {
    "User-Agent": "SUPER2026",
    "Referer": "",
    "Origin": ""
  }
}
```

ثم ارفع التعديل إلى GitHub، وسيعيد Vercel النشر تلقائياً إذا كان المستودع مربوطاً به.

> استخدم الروابط التي تملك حق إعادة بثها أو الوصول إليها.
