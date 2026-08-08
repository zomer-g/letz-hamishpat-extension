# מדריך העלאה ל-Firefox (AMO) — לץ המשפט

מדריך צעד-אחר-צעד להעלאה ראשונה של תוסף לץ המשפט לחנות התוספים של פיירפוקס
(addons.mozilla.org). אין צורך בידע בתכנות — הקבצים כבר בנויים.

**הקובץ שתעלה:** `src/dist/firefox-extension-v0.18.37.zip`
(נוצר ע"י `cd src && npm run build:firefox`, או `npm run build:all` שבונה גם את
חבילת הכרום מאותה גרסה).

> ✅ **גרסת הפיירפוקס זהה לגרסת הכרום** — שניהם נבנים מעץ מקור אחד (`src/`).
> התוסף בפיירפוקס כולל את מלוא הפיצ'רים: מסמכים, יומני דיונים, **יומן שופט/ת,
> איתור תיק מהיר, תיקים מועדפים** והחלונית הצפה.

---

## חלק 0 — מה כבר הוכן עבורך

- המניפסט מותמר אוטומטית בזמן הבנייה: background כ-event page, מזהה קבוע
  `court-downloader@z-g.co.il`, גרסת מינימום Firefox 140, והצהרת
  **"לא אוסף מידע"** (`data_collection_permissions: none`) — דרישת חובה של מוזילה
  להגשות חדשות מאז 11/2025.
- הורץ הליטנר הרשמי (`web-ext lint`): **0 שגיאות**. האזהרות שנותרו אינן חוסמות
  (אזהרת אנדרואיד + שימושי innerHTML שכולם עם תוכן מחוטא — מוזכר בהערות לבוחן).

---

## חלק 1 — הגדרת Google OAuth (לפני ההעלאה!)

בפיירפוקס ההתחברות ל-Google (‏Drive / יומן) עובדת אחרת מכרום, וכרגע בקוד יש
placeholder — בלי הצעד הזה כפתור "התחברות ל-Google" לא יעבוד אצל המשתמשים.

עקוב אחרי **[SETUP_FIREFOX.md](SETUP_FIREFOX.md)** — בקצרה:
1. טען את התוסף זמנית בפיירפוקס (`about:debugging` → Load Temporary Add-on) והרץ
   בקונסול שלו `browser.identity.getRedirectURL()` — קבל כתובת `https://….extensions.allizom.org/`.
2. ב-Google Cloud Console צור OAuth Client מסוג **Web application** (לא Chrome
   Extension!) עם ה-redirect URI מהצעד הקודם.
3. הדבק את ה-Client ID שקיבלת ב-`background/service-worker.js` שורה 17
   (`FIREFOX_OAUTH_CLIENT_ID = '...'`).
4. הרץ מחדש `node build-zip.js` (מתוך `src/`) כדי שה-zip יכלול את המזהה.

> אם אתה רוצה לפרסם *בלי* Drive/Calendar בשלב ראשון — אפשר לדלג, אבל אז כדאי
> לציין בהערות לבוחן שהחיבור ל-Google עדיין לא פעיל בגרסת פיירפוקס.

---

## חלק 2 — פתיחת חשבון מפתחים (פעם אחת, חינם)

1. https://addons.mozilla.org/developers/ → **Log in / Register** (חשבון Mozilla;
   אפשר להירשם עם `guy@z-g.co.il`).
2. מוזילה תדרוש **אימות דו-שלבי (2FA)** לפני העלאה ראשונה — Google Authenticator /
   Authy. **שמור את קודי הגיבוי.**
3. אשר את ה-Firefox Add-on Distribution Agreement.
4. בהגדרות הפרופיל קבע **Display Name** (אחרת יוצג המייל הגולמי בדף התוסף).

> להבדיל מכרום — אין תשלום 5$. הכל חינם.

---

## חלק 3 — העלאת התוסף

1. **Submit a New Add-on** (או ישירות:
   https://addons.mozilla.org/developers/addon/submit/distribution).
2. בשאלת ההפצה בחר **On this site** (מפורסם בחנות) → Continue.
3. העלה את `firefox-extension-v0.18.37.zip`.
   - ולידציה אוטומטית ~10–60 שניות. צפוי: **passed validation, 0 errors**
     (אזהרות — תקין, המשך).

---

## חלק 4 — שאלת קוד המקור: ענה No

בשאלה **"Do You Need to Submit Source Code?"** ענה **No**.

למה? השאלה בודקת אם *אתה* משתמש בכלי בנייה (minifier / webpack / template
engine / כל עיבוד קוד). אצלנו: כל הקוד JS רגיל לא-ממוזער, וסקריפט הבנייה רק
אורז zip. שני הקבצים הממוזערים היחידים הם ספריות צד-שלישי **רשמיות ולא-מעובדות**
— ולפי מדיניות מוזילה ספריות כאלה אינן מחייבות הגשת מקור (הבוחן מאמת מול
ה-release הרשמי).

כדי לחסוך לבוחן עבודה, הוסף להערות-לבוחן (חלק 6) את השורה:
> All extension code is plain, unminified JavaScript. The only minified files
> are two unmodified official third-party releases: jsPDF 2.5.1
> (https://github.com/parallax/jsPDF/releases/tag/v2.5.1) and JSZip 3.10.1
> (https://github.com/Stuk/jszip/releases/tag/v3.10.1), included as-is under
> `vendor/`.

> גיבוי ליתר ביטחון: אם בוחן בכל זאת יבקש מקור במהלך הביקורת, יש מוכן
> `dist/firefox-extension-source-v0.18.37.zip` — פשוט תעלה אותו בתגובה.

---

## חלק 5 — שדות הרישום (Listing)

העתק מ-**[AMO_LISTING.md](AMO_LISTING.md)** (שם, תקציר, תיאור בעברית + אנגלית).
בנוסף:
- **Categories:** Productivity (או Other).
- **Support email:** `guy@z-g.co.il`.
- **Privacy policy:** https://www.z-g.co.il/court-downloader/privacy — חובה למלא
  גם כשמוצהר "לא אוסף מידע".
- **Homepage:** https://www.z-g.co.il/court-downloader
- **צילומי מסך:** אותה סדרה ממותגת המשמשת בחנות כרום — `docs/screenshots/`
  ‏(1280×800, מתאימים גם ל-AMO). מאחר שהתוסף זהה בשני הדפדפנים, אפשר להשתמש
  **בכל הסדרה**: hero, documents, judge, locate, hearings.

---

## חלק 6 — הערות לבוחן

**אין מה לכתוב ידנית.** `npm run build:firefox` מייצר את ההערות יחד עם החבילה:

```
src/dist/AMO-reviewer-notes-<version>.txt
```

פתח את הקובץ והדבק את כולו לשדה **"Notes to Reviewer"**. הוא נבנה מהתבנית
[REVIEWER_NOTES_TEMPLATE.md](REVIEWER_NOTES_TEMPLATE.md), והגרסה, מספר הקבצים
בחבילה וה-checksums של הספריות המצורפות נקראים מהבנייה עצמה — כך שהם לא יכולים
להתפצל ממה שבאמת הוגש. לשינוי הנוסח — ערוך את **התבנית**, לא את הפלט.

התוכן מכסה כבר את כל מה שהבוחן צריך, כולל:
- **הוראות בנייה שלב-אחר-שלב** לשחזור עותק זהה (דרישת AMO כשיש קוד ממוזער).
- **קוד ממוזער**: הקוד שלנו אינו ממוזער כלל; שתי ספריות צד-שלישי מצורפות, עם
  מקור, גרסה ו-sha256 לכל אחת. jsPDF **מתועדת כמשונה** — הוסר ממנה טוען הקוד
  המרוחק היחיד (`cdnjs.../pdfobject.min.js`), וזה ההבדל היחיד מהמקור.
- **איך לבדוק את התוסף בלי הזדהות ישראלית** — דרך הפורטל הציבורי, כולל מספר תיק
  אמיתי לדוגמה. זה חוסך סבב שאלות עם הבוחן.

ודא שהנקודות האלה מופיעות (הן כלולות בתבנית):
- התוסף פועל רק בתוך הסשן המאומת של המשתמש באתר נט המשפט; לא קורא סיסמאות/עוגיות
  ולא מבצע הזדהות בשמו.
- **אין קוד מרוחק** — כל הספריות ארוזות.
- הרשאות המארח הן בדיוק דומייני נט המשפט + Google APIs (ליעדים שהמשתמש מפעיל).
- הצהרת איסוף הנתונים: none — שום דבר לא נשלח לשום שרת של המפתח.
- שימושי innerHTML בקוד הם עם תוכן מחוטא (esc) — מקור אזהרות הליטנר.

---

## חלק 7 — אחרי ההגשה

- ביקורת: אוטומטית + לעיתים אנושית; שעות עד ימים. מוזילה חותמת על התוסף באישור.
- עדכון גרסה: העלה גרסה עם `version` גבוה יותר במניפסט (`node build-zip.js` מחדש) —
  אותו מסלול, בלי למלא הכל מחדש.
- כשפורט הפיצ'רים החדשים (יומן שופט, מועדפים, איתור תיק) יושלם — זו פשוט תהיה
  גרסת עדכון.
