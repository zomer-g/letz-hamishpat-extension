# הגדרת יעדי הורדה — שרת API ו־Google Drive

התוסף יכול לשלוח את ה־PDF-ים שנבנו לשלושה יעדים (אפשר לשלב): **ZIP למחשב**, **שרת API שלך**, ו/או **Google Drive**. ZIP מקומי עובד מיידית ללא הגדרות. שני האחרים דורשים הגדרה חד־פעמית בעמוד ההגדרות של התוסף (אייקון ⚙ בפאנל, או `chrome://extensions` → פרטים → אפשרויות).

---

## 1. שרת API (POST multipart)

### מה התוסף שולח
לכל מסמך נבחר, ה־service worker שולח בקשה נפרדת:

```
POST <endpoint שהגדרת>
Content-Type: multipart/form-data
X-API-Key: <המפתח שהגדרת>     (נשלח רק אם מילאת מפתח)

שדות ה־form:
  file        → תוכן ה־PDF (Blob, application/pdf), עם filename
  filename    → שם הקובץ (כולל מספר סידורי + סוג + תאריך + כותרת)
  caseId      → מספר התיק (למשל 80819-05-26)
  docType     → סוג המסמך (החלטות / בקשות / ...)
  date        → תאריך המסמך
  submittedBy → גורם חותם / מגיש
  title       → כותרת מלאה
  docId       → מזהה המסמך במערכת
```

### מה השרת צריך להחזיר
כל קוד HTTP 2xx = הצלחה. כל דבר אחר נספר ככשל (ומדווח בפאנל). אין דרישת פורמט לגוף התשובה.

### התאמה ל־court_downloader הקיים
אפשר להוסיף ל־`app.py` route חדש, למשל:

```python
@app.route("/api/v1/intake", methods=["POST"])
@require_api_key                      # כבר קיים בפרויקט — בודק X-API-Key
def api_intake():
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "no file"}), 400
    meta = {k: request.form.get(k, "") for k in
            ("caseId", "docType", "date", "submittedBy", "title", "docId")}
    # כאן: להעלות ל־R2 דרך presigned PUT, או לשמור זמנית.
    # חשוב: לא לכתוב סינכרונית ל־DB בכל קובץ (ראה אזהרת ה־bandwidth ב־CLAUDE.md).
    return jsonify({"ok": True, "filename": f.filename}), 200
```

> ⚠️ לפי `CLAUDE.md`: אל תזרים את בייטים של הקובץ דרך Flask אם אפשר — עדיף שה־route יחזיר presigned PUT ל־R2 וה־worker/לקוח יעלה ישירות. הנתיב כאן הוא דרך הפשוטה; לנפחים גדולים שקול presigned. כמו כן, אל תכתוב ל־Neon בכל קובץ — צבור ושמור עם ה־debounce הקיים.

### הרשאות
התוסף לא מבקש מראש הרשאה לכל אתר. כשתשמור endpoint בעמוד ההגדרות, Chrome יבקש הרשאה ל־origin הספציפי של הכתובת — אשר אותה. כפתור "בדיקת חיבור" שולח POST ריק (עם הכותרת `X-CD-Probe: 1`) כדי לוודא שהכתובת נגישה.

---

## 2. Google Drive + Google Calendar (OAuth דרך התוסף)

ההעלאה ל־Drive וסנכרון היומן משתמשים ב־`chrome.identity` + Google APIs. ה־scopes:
- `drive.file` *(ברירת מחדל — non-sensitive)* — התוסף רואה רק קבצים שהוא עצמו יצר. בהתחברות הראשונה התוסף יוצר אוטומטית תיקייה בשם **"מסמכי נט המשפט"** ב-My Drive ושומר אליה את כל ההורדות. אין מסך אזהרה "Google hasn't verified", אין תקרת 100 משתמשים.
- `drive.metadata.readonly` *(אופציונלי — restricted)* — מתבקש רק כשהמשתמש פותח "אפשרויות מתקדמות → בחירת תיקייה מותאמת". מאפשר לקריאת שמות תיקיות קיימות עבור בורר התיקיות. דורש אימות Google + CASA → עד שהאימות מסתיים, המשתמש רואה מסך "Google hasn't verified" ויכול ללחוץ Advanced כדי להמשיך.
- `calendar` — יצירה/עדכון של אירועי דיון ביומן שתבחר (סנכרון דיונים).

דרושה הגדרת OAuth client ב־Google Cloud, **חד־פעמית**.

### שלב א — מזהה התוסף יציב
OAuth של Chrome קשור ל־ID של התוסף. כדי שה־ID לא ישתנה:
1. ארוז את התוסף פעם אחת ל־`.crx` (או טען unpacked ושמור את ה־ID), או הוסף שדה `"key"` ל־`manifest.json` (ה־public key של התוסף). ה־ID מופיע ב־`chrome://extensions`.

### שלב ב — OAuth client ב־Google Cloud
1. https://console.cloud.google.com → צור Project (או בחר קיים).
2. **APIs & Services → Library** → הפעל **Google Drive API** וגם **Google Calendar API** (השני נדרש רק אם תשתמש בסנכרון דיונים ליומן).
3. **APIs & Services → OAuth consent screen** → External → מלא שם אפליקציה ואימייל. הוסף את כתובת המייל שלך תחת **Test users** (כל עוד האפליקציה לא מאומתת, רק test users יכולים להתחבר).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Chrome Extension** (אם אין — בחר *Chrome App*).
   - Item ID: הדבק את **ה־ID של התוסף** מ־`chrome://extensions`.
5. העתק את ה־**Client ID** שנוצר (נראה כמו `1234-abcd.apps.googleusercontent.com`).

### שלב ג — הזנה ל־manifest
ב־`chrome/manifest.json`, החלף את ה־placeholder:

```json
"oauth2": {
  "client_id": "הדבק-כאן-את-ה-CLIENT-ID.apps.googleusercontent.com",
  "scopes": [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
    "https://www.googleapis.com/auth/calendar"
  ]
}
```

טען מחדש את התוסף.

### שלב ד — חיבור ובחירת תיקייה
1. בעמוד ההגדרות (או ב־popup) → לחץ **"התחבר ל־Google"** → אשר בחלון ההזדהות. אמור להופיע "✓ מחובר".
2. לחץ **"בחר תיקייה"** — נפתח בורר תיקיות מובנה: נווט ב־Drive שלך, צור תיקייה חדשה אם צריך, ובחר את היעד (מוצג לפי **שם**, לא ID). הקבצים יועלו לתת־תיקייה אוטומטית לפי מספר התיק ושם הרשימה.
3. סמן את יעד "Google Drive" → שמור. אופציונלי: הפעל "העלה רק קבצים חדשים" כדי למנוע כפילויות.

### שלב ה — סנכרון דיונים ליומן (אופציונלי)
בפרופיל הדיונים: התחבר ל־Google, בחר/צור לוח שנה ליעד, והתאם את תבניות הכותרת/מיקום/תיאור. בכל סנכרון התוסף מייבא את הדיונים כאירועים ללוח השנה שבחרת.

> אם "התחבר ל־Google" מחזיר שגיאה כמו `bad client id` או `no token` — ה־`client_id` ב־manifest שגוי או ש־ID התוסף לא תואם ל־Item ID שהגדרת ב־Google Cloud. אם סנכרון היומן נכשל — ודא ש־**Google Calendar API** מופעל ושה־scope `calendar` קיים ב־manifest.

---

## סיכום זרימה
```
בחירת מסמכים → "הורד"
      │
      ▼  (לכל מסמך, בלשונית אחת)
postback → DocumentNumber → GetAllImages → PDF (jsPDF)
      │
      ├─ ZIP מקומי     → הורדה אחת (ZIP + index.csv)
      ├─ שרת API       → POST multipart לכל קובץ (service worker)
      └─ Google Drive  → העלאה לכל קובץ (service worker + OAuth)
```
כל היעדים המסומנים מקבלים את אותם קבצים באותה ריצה.
