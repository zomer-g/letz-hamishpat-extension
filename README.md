# לץ המשפט — תוסף כרום לנט המשפט ⚖️🃏

**לץ המשפט** הוא תוסף Chrome (Manifest V3) שמוסיף כלי עבודה מהירים למערכת **נט המשפט** של בתי המשפט בישראל — הורדת מסמכים בבת אחת, ייצוא יומני דיונים, יומן שופט/ת, איתור תיק מהיר ותיקים מועדפים. הכול רץ מקומית בדפדפן, בתוך הסשן המחובר של המשתמש.

> 🛒 [להתקנה מחנות Chrome](https://chromewebstore.google.com/) · 🌐 [עמוד התוסף](https://www.z-g.co.il/court-downloader) · 🔒 [מדיניות פרטיות](https://www.z-g.co.il/court-downloader/privacy)

![לץ המשפט](docs/screenshots/hero.png)

| | |
|---|---|
| ![הורדת מסמכים](docs/screenshots/documents.png) | ![יומן שופט](docs/screenshots/judge.png) |
| ![איתור תיק ומועדפים](docs/screenshots/locate.png) | ![ייצוא יומן דיונים](docs/screenshots/hearings.png) |

## מה התוסף עושה

- **📥 הורדת מסמכים באצווה** — סימון מסמכים מכל תיקיות התיק (החלטות, בקשות, כתבי טענות, פרוטוקולים, מוצגים, תיק נייר…) והורדה כ-ZIP אחד עם אינדקס CSV. ה-PDF נבנה בדפדפן (jsPDF) מתוך ה-viewer של האתר.
- **📅 יומני דיונים** — ייצוא רשימות דיונים (כולל "הדיונים שלי" חוצה-תיקים בטווח תאריכים) כ-CSV + ICS, או סנכרון ישיר ל-Google Calendar.
- **👩‍⚖️ יומן שופט/ת** — איסוף אוטומטי של דוח "דיונים לשופט ליום דיונים" על פני טווח תאריכים והצגתו כיומן שבועי/חודשי אינטראקטיבי. עובד גם בפורטל הציבורי וגם במאובטח.
- **🔎 איתור תיק מהיר** — הדבקת מספר תיק בכל פורמט (`39163-07-22`, `39163/07/2022`, `ת"א 39163-07-22`) ופתיחה בלחיצה אחת.
- **⭐ תיקים מועדפים** — סימון תיקים בכוכב וכניסה מהירה אליהם; נשמר מקומית בלבד.
- **☁️ יעדים אופציונליים** — לצד ה-ZIP המקומי: שרת API אישי (multipart + `X-API-Key`) או Google Drive. מופעלים רק אם המשתמש הגדיר אותם, עם ההרשאות שלו.

שתי תצורות תצוגה לכל פיצ'ר: **מוטמע** בתוך עמודי האתר, או **חלונית צפה**.

## פרטיות ואבטחה

- אין שרת של התוסף. שום נתון לא נשלח לשום מקום כברירת מחדל — הכול נשאר בדפדפן.
- התוסף רץ בתוך הסשן הקיים של המשתמש ולא נוגע בסיסמאות/עוגיות; הוא לא מבצע הזדהות בשם המשתמש.
- יעדי Drive/Calendar משתמשים ב-OAuth של Google בהיקפים מינימליים (`drive.file`, `calendar`); שרת ה-API והמפתח מוזנים ע"י המשתמש ונשמרים ב-`chrome.storage`.
- אין קוד מרוחק: כל הספריות (jsPDF, JSZip) ארוזות בתוסף.

פירוט מלא: [PRIVACY_POLICY.md](PRIVACY_POLICY.md) · [REVIEWER_NOTES.md](REVIEWER_NOTES.md) (תרשים זרימת נתונים).

## התקנה לפיתוח (Load unpacked)

```
git clone https://github.com/zomer-g/letz-hamishpat-extension.git
```
1. `chrome://extensions` → הפעלת **מצב מפתח**.
2. **טעינת תוספת לא ארוזה** → בחירת תיקיית הריפו.
3. כניסה לנט המשפט כרגיל (כרטיס חכם / הזדהות ממשלתית / הפורטל הציבורי).

> ⚠️ אין להשאיר את גרסת החנות מותקנת לצד העותק המקומי — שני עותקים חולקים מצב עמוד ומשבשים זה את זה ([TESTING.md](TESTING.md)).

## פיתוח ובדיקות

```bash
npm ci          # מתקין את jsdom (תלות פיתוח יחידה)
npm test        # ‏270+ בדיקות jsdom, ללא רשת
npm run build   # אורז dist/extension-v<version>.zip לחנות
```

- **בדיקות רגרסיה**: כל גרסה נבדקת גם ביחידות (jsdom) וגם חי — על שני הדומיינים (ציבורי + מאובטח) ובשתי התצורות. צ'קליסט: [TESTING.md](TESTING.md), תכנית מלאה: [TEST_PLAN.md](TEST_PLAN.md).
- **מבנה הקוד**: `content/` סקריפטי תוכן (פאנלים, אוספים, יומן), `shared/` עזרים (CSV/ICS/ZIP/פרסור), `background/` service worker (יעדים אופציונליים בלבד), `vendor/` ספריות ארוזות.

```
manifest.json                  # MV3 · activeTab, storage, identity
content/
├── list-panel.js              # פאנל המסמכים (AG-Grid → בחירה → ZIP)
├── hearings-panel.js          # פאנל הדיונים (CSV/ICS/סנכרון)
├── judge-runner.js            # מכונת מצבים לאיסוף יומן שופט בטאב ייעודי
├── judge-calendar.js          # תצוגת היומן (יום/4 ימים/שבוע/חודש)
├── case-open.js · favorites.js · case-judge-chip.js
└── adapters/                  # קריאת ה-DOM/ArrayStore של נט המשפט
shared/  background/  popup/  options/  tests/
```

## English (in brief)

**Letz HaMishpat** ("The Court Jester") is an MV3 Chrome extension that adds power tools to Israel's *Net HaMishpat* court portal: bulk document download (ZIP + CSV index, PDFs built client-side), hearing-list export (CSV/ICS/Google Calendar), an interactive judge-docket calendar, instant case locate, and local favorites. Everything runs client-side inside the user's own authenticated session; optional Drive/Calendar/API destinations are user-configured. No remote code, no extension server, no data collection. `npm ci && npm test` runs the offline jsdom suite.

## רישיון

[MIT](LICENSE) © Guy Zomer. קוד הסקרייפר/השרת הנלווה אינו חלק מריפו זה.
