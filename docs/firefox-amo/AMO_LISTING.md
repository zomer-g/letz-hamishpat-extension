# addons.mozilla.org — Listing copy

_Reflects extension version 0.17.15._

## Name
מוריד מסמכים אצווה — נט המשפט

## Summary (max 250 chars on AMO)
סמן מסמכים או דיונים בתיק בנט המשפט והורד את כולם לקובץ ZIP/CSV/ICS אחד. שומר על הסשן האישי שלך, ללא שרת חיצוני בברירת מחדל. אופציונלי: סנכרון ל-Google Drive או Google Calendar.

## Categories
- Productivity

## Tags
court, israel, legal, hebrew, net-hamishpat, pdf, zip, calendar, drive

## Default locale
he (Hebrew)

## Detailed description
התוסף נועד לעורכי דין, מתמחים ובעלי דין שמנהלים תיקים בנט המשפט ומעוניינים להוציא מהתיק מספר רב של פריטים במכה אחת — בלי לטפל בכל אחד בנפרד.

**מסמכים**
1. מתחברים לנט המשפט באופן הרגיל (כרטיס חכם, SSO ממשלתי וכו'). התוסף לא נוגע בתהליך ההזדהות.
2. נכנסים לעמוד רשימת המסמכים של תיק. פס "📥 הורדת מסמכים" מופיע מעל הטבלה, ותיבת סימון מופיעה ליד כל שורה.
3. בוחרים מסמכים — ידנית, "סמן הכל בעמוד זה", או "סמן הכל בכל העמודים" (התוסף עובר על עמודי הדפדוף עבורך). סוגים נתמכים: החלטות, בקשות, כתבי טענות, תצהירים, פסקי דין, פרוטוקולים, מוצגים ותיק נייר.
4. לוחצים "הורד נבחרים". התוסף מוריד את הקבצים דרך הסשן המאומת שלכם, אורז אותם ל־ZIP יחיד עם `index.csv` (שם קובץ, סוג מסמך, תאריך, מגיש, מס׳ עמודים, מקור). תיקים גדולים מתפצלים לכמה קובצי ZIP; אפשר לבטל באמצע, ואם הסשן פג — להתחבר מחדש ולהמשיך מאותה נקודה.

**דיונים ויומן**
- הורדת רשימות דיונים (כולל מצב "הדיונים שלי" עם טווח תאריכים) כ-CSV וכקובץ ICS לייבוא לכל יומן.
- סנכרון אופציונלי ל-Google Calendar — אירוע לכל דיון בלוח שנה שתבחר, עם תבניות כותרת/מיקום/תיאור.

**יעדים גמישים**
- הורדה מקומית (ZIP) — ברירת המחדל.
- שרת API אישי — שליחת כל קובץ ל-endpoint שתגדיר, עם כותרת `X-API-Key`.
- Google Drive — העלאה לתת-תיקייה לפי מספר התיק ושם הרשימה, עם בורר תיקיות מובנה, יצירת תיקייה, ומניעת כפילויות.

**מה לא קורה**
- בברירת מחדל אין שרת חיצוני — כל ההורדה והאריזה מתבצעות בדפדפן.
- יעדי שרת/Drive/Calendar פועלים רק אם הפעלת אותם בעצמך ועם הפרטים שלך.
- אין גישה לסיסמאות, ל-cookies או לפרטי הזדהות. אין מעקב, אנליטיקה או טלמטריה.

**רישיון ופרטיות**
- דף הבית: https://www.z-g.co.il/court-downloader
- מדיניות פרטיות מלאה: https://www.z-g.co.il/court-downloader/privacy
- תנאי שימוש: https://www.z-g.co.il/court-downloader/terms

**הסבר על ההרשאות**
- `activeTab` — קריאת הרשימה בלשונית הנוכחית, רק כשמשתמשים בתוסף.
- `storage` — שמירת העדפות הגדרה בלבד.
- `identity` — התחברות OAuth ל-Google, רק עבור יעדי Drive/Calendar האופציונליים.
- מארח `securesso.court.gov.il` ו-`www.court.gov.il` — הורדת הפריטים שבחרת מאתר המקור.
- מארח `www.googleapis.com` ו-`accounts.google.com` — Drive/Calendar כשמופעל, וחלון ההסכמה של גוגל.

**מי אנחנו**
מפותח עצמאית על ידי עו"ד גיא זומר · guy@z-g.co.il

---

## Privacy policy URL
https://www.z-g.co.il/court-downloader/privacy

## Homepage URL
https://www.z-g.co.il/court-downloader

## Support email
guy@z-g.co.il

## Support site
https://www.z-g.co.il/court-downloader

## License
All Rights Reserved (proprietary). Bundled libraries — jsPDF (MIT) and JSZip (MIT) — retain their upstream licenses.

## Data collection disclosure
- Personal information collected: **No**
- Health information: No
- Financial / payment information: No
- Authentication information: No (extension never sees credentials)
- Personal communications: No
- Location: No
- Web history: No
- Activity data: No
- Website content: No (other than the documents the user explicitly chooses to export)

The extension transmits data ONLY to destinations the user explicitly configures:
their own server endpoint, their own Google Drive, or their own Google Calendar.
No data is ever sent to the developer.
