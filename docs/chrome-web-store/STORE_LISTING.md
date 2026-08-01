# Chrome Web Store Listing — לץ המשפט

_Reflects extension version 0.19.0._

## עברית (he, primary)

### Name (≤75)
לץ המשפט — הורדת מסמכים ודיונים מנט המשפט בלחיצה

### Summary (≤132)
מזהה תיק בנט המשפט ומוריד את כל המסמכים ל-ZIP, ורשימות דיונים ל-CSV/ICS — כולל סנכרון ל-Google Calendar. מקומי בדפדפן, על הסשן שלך.

### Detailed description
לץ המשפט מזהה אוטומטית מתי אתם נמצאים בעמוד רשימת מסמכים או דיונים בנט המשפט, ומציע להוציא את כולו בלחיצה אחת — בלי לטפל בכל פריט בנפרד, בלי לכתוב סקריפט, ובלי לשלוח דבר לשרת חיצוני. כל ההורדה והאריזה מתבצעות מקומית בדפדפן שלכם, דרך הסשן המאומת שכבר פתחתם (כרטיס חכם / SSO ממשלתי). התוסף לא נוגע בתהליך ההזדהות ולא רואה סיסמאות או cookies.

מה אפשר להוריד:

• מסמכי תיק — מסמנים מסמכים ברשימה (ידנית, "סמן הכל בעמוד", או "סמן הכל בכל העמודים" — התוסף עובר על הדפדוף עבורכם) והוא מוריד את כולם ואורז ל-ZIP יחיד עם index.csv (שם, סוג מסמך, תאריך, מגיש, מס׳ עמודים, מקור). תיקים גדולים מתפצלים לכמה קובצי ZIP; אפשר לבטל באמצע, ואם הסשן פג — להתחבר מחדש ולהמשיך. נתמכים: החלטות, בקשות, כתבי טענות, תצהירים, פסקי דין, פרוטוקולים, מוצגים ותיק נייר.
• יומן דיונים — רשימת הדיונים שלכם (כולל מסך "הדיונים שלי"), מועדי דיון בתיק בודד, או דיונים לפי שופט בטווח תאריכים — כ-CSV מסודר וכקובץ ICS לייבוא לכל יומן. אפשר לסמן אילו דיונים לייצא.
• סנכרון ל-Google Calendar — בוחרים שכבת יומן, והתוסף יוצר אירוע לכל דיון: מספר ושם התיק ככותרת, בית המשפט כמיקום, השופט בתיאור. סנכרון חוזר מעדכן אירועים קיימים בלי ליצור כפילויות, עם חותמת זמן של הסנכרון האחרון.

• איתור תיק לפי תיק מקור — מחפשים תיק בית משפט לפי מספר תיק המקור שלו (דו"ח תעבורה, תיק משטרתי (פל"א), תיק הוצל"פ, הודעת קנס ועוד), ישירות משורת האיתור המהיר. בחלונית התוסף אפשר גם להדביק רשימה שלמה של מספרי תיק מקור ולקבל טבלה של תיקי בית המשפט שנמצאו לכל אחד — להעתקה לאקסל או לייצוא CSV.

תכונות:
• שם קובץ לפי סוג המסמך — לא לפי שם הצד המגיש; מסמכי "אישור הגשה" מדולגים כברירת מחדל.
• כל CSV כולל UTF-8 BOM ונפתח נכון ב-Excel בעברית; ICS תקני (RFC 5545) עם אזור זמן Asia/Jerusalem ו-UID יציב (בלי כפילויות בייבוא חוזר).
• יעדי הורדה גמישים: הורדה מקומית (ZIP) כברירת מחדל, או העלאה ל-Google Drive עם בורר תיקיות מובנה ומניעת כפילויות, או שרת API אישי (endpoint + X-API-Key) — שניהם פועלים רק אם תפעילו אותם עם הפרטים שלכם.
• ממשק צף או מוטמע בעמוד, לבחירתכם; אפשר להסתיר את החלון ולהוריד ישירות מהתפריט של התוסף.

פרטיות:
• כל ההורדה מתבצעת בדפדפן שלכם מול שרתי נט המשפט — אין שרת אמצעי, אין שירות ענן, ושום נתון על התיקים או ההורדות שלכם לא נשלח אלינו.
• אין גישה לסיסמאות, ל-cookies או לפרטי הזדהות. אין מעקב, אנליטיקה או טלמטריה.
• יעדי Drive / Calendar / שרת API פועלים רק אם תגדירו אותם במפורש, ורק מול החשבון והכתובת שלכם.

עמוד הבית: https://www.z-g.co.il/court-downloader
מדיניות פרטיות: https://www.z-g.co.il/court-downloader/privacy
תנאי שימוש: https://www.z-g.co.il/court-downloader/terms
פותח עצמאית על ידי עו"ד גיא זומר · guy@z-g.co.il

---

## English (en, secondary)

### Name (≤75)
לץ המשפט — One-Click Downloader for Israel's Net HaMishpat Court Portal

### Summary (≤132)
Detects Net HaMishpat cases: download documents to ZIP, hearing lists to CSV/ICS, and sync hearings to Google Calendar. In-browser.

### Detailed description
לץ המשפט ("the Court Jester") auto-detects when you're on a documents or hearings list in Israel's Net HaMishpat court portal, and offers to export the whole thing in one click — no per-item handling, no scripting, nothing sent to an external server. All downloading and packaging run locally in your browser, over the authenticated session you already opened (smart card / government SSO). The extension never touches the login flow and never sees passwords or cookies.

What you can download:

• Case documents — check items in the list (manually, "select all on page", or "select all across pages" — the extension walks the pagination for you), and it downloads them all into a single ZIP with an index.csv (name, document type, date, filer, page count, source). Large cases split into several ZIPs; you can cancel mid-run, and if the session expires, re-authenticate and continue. Supported: decisions, motions, pleadings, affidavits, judgments, protocols, exhibits and the paper file.
• Hearings calendar — your hearing list (including the "My Hearings" screen), a single case's hearing dates, or a judge's hearings over a date range — as a clean CSV and an ICS file for import into any calendar. You can pick which hearings to export.
• Google Calendar sync — choose a calendar, and the extension creates an event per hearing: case number + name as the title, the court as the location, the judge in the description. Re-syncing updates existing events without creating duplicates, and records a last-sync timestamp.

Features:
• Files are named by document type — not by the filing party; "submission confirmation" documents are skipped by default.
• Every CSV includes a UTF-8 BOM so it opens correctly in Hebrew Excel; ICS is standards-compliant (RFC 5545) with Asia/Jerusalem timezone and a stable UID (no duplicates on re-import).
• Flexible destinations: local ZIP by default, or Google Drive with a built-in folder picker and de-duplication, or a personal API server (endpoint + X-API-Key) — the latter two run only if you enable them with your own details.
• Floating or in-page UI, your choice; you can hide the window and download straight from the toolbar popup.

Privacy:
• All downloading runs in your own browser against Net HaMishpat servers — no relay, no cloud, nothing about your cases or downloads is sent to us.
• No access to passwords, cookies or credentials. No tracking, analytics or telemetry.
• Drive / Calendar / API-server destinations run only if you explicitly configure them, and only against your own account and address.

Homepage: https://www.z-g.co.il/court-downloader
Privacy policy: https://www.z-g.co.il/court-downloader/privacy
Terms of use: https://www.z-g.co.il/court-downloader/terms
Independently developed by Adv. Guy Zomer · guy@z-g.co.il

### Category
Productivity
