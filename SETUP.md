# SAFE PRO AEO Tracker – setup

1. **GitHub repo**: create an empty *private* repository and upload this folder
   (tracker.py, requirements.txt, .github/workflows/weekly.yml).
2. **Google access for the script**: in Google Cloud Console create a service
   account, enable the Google Sheets API, download its JSON key. Share the
   prompt sheet with the service account's email as Editor.
3. **Secrets** (repo → Settings → Secrets and variables → Actions → New secret):
   GOOGLE_SERVICE_ACCOUNT_JSON (whole JSON file), and whichever of
   OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, PERPLEXITY_API_KEY,
   XAI_API_KEY, SERPAPI_API_KEY you have. Missing ones are skipped.
4. **Variables** (same page, Variables tab): SHEET_ID (optional, defaults to the
   tracker sheet) and WEEK1_DATE = the date of the first full run (YYYY-MM-DD).
5. **Test**: Actions → Weekly AEO tracking → Run workflow, limit = 10.
   Check the Results and Scores tabs in the sheet.
6. After that it runs itself every Monday at 9:00 AM IST.

Notes: ANTHROPIC_API_KEY is also used to score tone and accuracy of answers
that mention Safe Pro. Edit COMPETITORS and model names at the top of tracker.py.
