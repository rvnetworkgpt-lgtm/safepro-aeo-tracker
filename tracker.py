"""
SAFE PRO AEO Tracker - weekly runner.

Sends every active prompt from the Google Sheet to each AI engine (with web
search on), saves the answer and its cited links, scores it, and writes:
  - "Results" tab: one row per prompt x engine x week
  - "Scores" tab:  one row per engine x week with the KPIs from the task plan

Usage:
  python tracker.py --limit 10 --engines claude,perplexity   # test run
  python tracker.py                                          # full weekly run
  python tracker.py --dry-run --limit 3                      # no sheet writes

All keys come from environment variables (GitHub Actions secrets). An engine
whose key is missing is skipped, so you can start with only some of them.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import traceback

import requests

# ---------------------------------------------------------------- settings --

SHEET_ID = os.environ.get("SHEET_ID", "1wr_9Jz1AQaxougIs-V7uzKZlFmmgKI7dhNwM5fqMw3w")
WEEK1_DATE = os.environ.get("WEEK1_DATE", "")  # e.g. 2026-11-30; blank = this run is Week 1
BRAND_RE = re.compile(r"\bsafe\s*-?\s*pro\b", re.I)
BRAND_DOMAIN = "safeprofire.com"

# Competitors to count for share of voice and ranking. Edit freely.
# Each entry is the short name searched for in answers (case-insensitive).
COMPETITORS = [
    "Ceasefire",        # Ceasefire Industries
    "Safex",            # Safex Fire Services
    "Kanex",            # Kanex Fire Solutions
    "Minimax",          # Minimax India
    "Supremex",         # Supremex Fire
    "New Age",          # NewAge Fire Protection (matches "NewAge" too)
    "Impact Fire",      # Impact Fire & Safety
    "Usha Fire",        # Usha Fire Safety
    "HD Fire",          # HD Fire Protect
    "Firepro",          # Firepro Systems
]

# Model names are settings, not code: change them here or via env when
# providers release new ones.
MODELS = {
    "chatgpt": os.environ.get("OPENAI_MODEL", "gpt-5"),
    "gemini": os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
    "claude": os.environ.get("CLAUDE_MODEL", "claude-opus-5-5"),
    "perplexity": os.environ.get("PERPLEXITY_MODEL", "sonar"),
    "grok": os.environ.get("XAI_MODEL", "grok-4"),
    "judge": os.environ.get("JUDGE_MODEL", "claude-haiku-5-5"),
}

SYSTEM_HINT = "The user is in India. Answer the question as you normally would, naming specific companies or brands where relevant."

URL_RE = re.compile(r"https?://[^\s\)\]\}>\"']+")


# ----------------------------------------------------------------- engines --
# Each returns (answer_text, [cited_urls]).

def ask_chatgpt(prompt):
    from openai import OpenAI
    client = OpenAI()
    r = client.responses.create(
        model=MODELS["chatgpt"],
        tools=[{"type": "web_search"}],
        instructions=SYSTEM_HINT,
        input=prompt,
    )
    urls = []
    for item in r.output or []:
        for c in getattr(item, "content", None) or []:
            for a in getattr(c, "annotations", None) or []:
                if getattr(a, "type", "") == "url_citation":
                    urls.append(a.url)
    return r.output_text or "", urls


def ask_gemini(prompt):
    key = os.environ["GEMINI_API_KEY"]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODELS['gemini']}:generateContent"
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM_HINT}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "tools": [{"google_search": {}}],
    }
    r = requests.post(url, params={"key": key}, json=body, timeout=120)
    r.raise_for_status()
    cand = (r.json().get("candidates") or [{}])[0]
    text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []))
    urls = []
    for ch in cand.get("groundingMetadata", {}).get("groundingChunks", []):
        web = ch.get("web", {})
        # Gemini returns redirect URLs; the title holds the real domain.
        urls.append(web.get("title") or web.get("uri", ""))
    return text, urls


def ask_claude(prompt):
    import anthropic
    client = anthropic.Anthropic()
    msg = client.beta.messages.create(
        model=MODELS["claude"],
        max_tokens=16000,
        system=SYSTEM_HINT,
        output_config={"effort": "low"},
        tools=[{"type": "web_search_20260209", "name": "web_search", "max_uses": 5}],
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        messages=[{"role": "user", "content": prompt}],
    )
    if msg.stop_reason == "refusal":
        return "[refused]", []
    text, urls = [], []
    for b in msg.content:
        if b.type == "text":
            text.append(b.text)
            for c in getattr(b, "citations", None) or []:
                if getattr(c, "url", None):
                    urls.append(c.url)
        elif b.type == "web_search_tool_result" and isinstance(b.content, list):
            urls.extend(getattr(x, "url", "") for x in b.content)
    return "".join(text), urls


def ask_perplexity(prompt):
    r = requests.post(
        "https://api.perplexity.ai/chat/completions",
        headers={"Authorization": f"Bearer {os.environ['PERPLEXITY_API_KEY']}"},
        json={"model": MODELS["perplexity"], "messages": [
            {"role": "system", "content": SYSTEM_HINT},
            {"role": "user", "content": prompt}]},
        timeout=120,
    )
    r.raise_for_status()
    d = r.json()
    urls = d.get("citations") or [s.get("url") for s in d.get("search_results", [])]
    return d["choices"][0]["message"]["content"], urls


def ask_grok(prompt):
    # xAI's API is OpenAI-compatible; web search via its Responses endpoint.
    # Verify on the first test run: xAI changes this surface often.
    r = requests.post(
        "https://api.x.ai/v1/responses",
        headers={"Authorization": f"Bearer {os.environ['XAI_API_KEY']}"},
        json={"model": MODELS["grok"], "instructions": SYSTEM_HINT,
              "input": prompt, "tools": [{"type": "web_search"}]},
        timeout=180,
    )
    r.raise_for_status()
    d = r.json()
    text, urls = [], list(d.get("citations") or [])
    for item in d.get("output", []):
        for c in item.get("content", []) or []:
            if c.get("type") in ("output_text", "text"):
                text.append(c.get("text", ""))
                urls += [a.get("url") for a in c.get("annotations", []) if a.get("url")]
    return "".join(text), urls


def _serp(params):
    r = requests.get("https://serpapi.com/search.json",
                     params={**params, "api_key": os.environ["SERPAPI_API_KEY"]}, timeout=120)
    r.raise_for_status()
    return r.json()


def _blocks_text(blocks):
    out = []
    for b in blocks or []:
        out.append(b.get("snippet") or b.get("title") or "")
        for li in b.get("list", []) or []:
            out.append(li.get("snippet") or li.get("title") or "")
        out.append(_blocks_text(b.get("text_blocks")))
    return "\n".join(x for x in out if x)


def ask_google_aio(prompt):
    d = _serp({"engine": "google", "q": prompt, "gl": "in", "hl": "en"})
    aio = d.get("ai_overview") or {}
    if aio.get("page_token"):  # AI Overview is loaded with a second request
        aio = _serp({"engine": "google_ai_overview", "page_token": aio["page_token"]}).get("ai_overview", {})
    if not aio:
        return "[no AI Overview shown]", []
    return _blocks_text(aio.get("text_blocks")), [r.get("link") for r in aio.get("references", [])]


def ask_google_ai_mode(prompt):
    d = _serp({"engine": "google_ai_mode", "q": prompt, "gl": "in", "hl": "en"})
    return _blocks_text(d.get("text_blocks")), [r.get("link") for r in d.get("references", [])]


ENGINES = {
    "chatgpt": (ask_chatgpt, "OPENAI_API_KEY"),
    "gemini": (ask_gemini, "GEMINI_API_KEY"),
    "claude": (ask_claude, "ANTHROPIC_API_KEY"),
    "perplexity": (ask_perplexity, "PERPLEXITY_API_KEY"),
    "grok": (ask_grok, "XAI_API_KEY"),
    "google_aio": (ask_google_aio, "SERPAPI_API_KEY"),
    "google_ai_mode": (ask_google_ai_mode, "SERPAPI_API_KEY"),
}


# ----------------------------------------------------------------- scoring --

def rank_of_brand(text):
    """Position of Safe Pro among all named companies, by first mention (1 = first)."""
    hits = []
    m = BRAND_RE.search(text)
    if m:
        hits.append((m.start(), "Safe Pro"))
    for c in COMPETITORS:
        mm = re.search(r"\b" + re.escape(c).replace(r"\ ", r"\s*") + r"\b", text, re.I)
        if mm:
            hits.append((mm.start(), c))
    hits.sort()
    names = [h[1] for h in hits]
    return (names.index("Safe Pro") + 1 if "Safe Pro" in names else None), [n for n in names if n != "Safe Pro"]


JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "sentiment": {"type": "string", "enum": ["positive", "neutral", "negative"]},
        "recommended": {"type": "boolean"},
        "accurate": {"type": "string", "enum": ["yes", "no", "partly"]},
        "inaccuracies": {"type": "string"},
    },
    "required": ["sentiment", "recommended", "accurate", "inaccuracies"],
    "additionalProperties": False,
}

FACTS = ("Safe Pro Fire Services Pvt. Ltd.: fire-safety equipment manufacturer, founded 2000, "
         "HQ Kurla West, Mumbai; plant in Bhiwandi; 50,000+ customers; 120 products across 15 "
         "categories; branches across 16 Indian states; website safeprofire.com.")


def judge_prompt(answer):
    return (f"Verified facts about the brand:\n{FACTS}\n\nAI answer to score:\n<answer>\n{answer[:12000]}\n</answer>\n\n"
            "How does this answer portray Safe Pro (sentiment)? Does it recommend Safe Pro? "
            "Are its statements about Safe Pro consistent with the verified facts? List any inaccuracies briefly, or ''.")


def judge_gemini(answer):
    """Free option: score with Gemini (structured JSON output)."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODELS['gemini']}:generateContent"
    schema = {k: v for k, v in JUDGE_SCHEMA.items() if k != "additionalProperties"}
    body = {"contents": [{"role": "user", "parts": [{"text": judge_prompt(answer)}]}],
            "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema}}
    r = requests.post(url, params={"key": os.environ["GEMINI_API_KEY"]}, json=body, timeout=120)
    r.raise_for_status()
    return json.loads(r.json()["candidates"][0]["content"]["parts"][0]["text"])


def judge(answer):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return judge_gemini(answer)
    import anthropic
    client = anthropic.Anthropic()
    msg = client.messages.create(
        model=MODELS["judge"],
        max_tokens=1024,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
        messages=[{"role": "user", "content":
                   judge_prompt(answer)}],
    )
    text = next(b.text for b in msg.content if b.type == "text")
    return json.loads(text)


def score(answer, urls):
    urls = [u for u in urls if u]
    urls += [u for u in URL_RE.findall(answer) if u not in urls]
    mentioned = bool(BRAND_RE.search(answer)) or any(BRAND_DOMAIN in u for u in urls)
    cited = [u for u in urls if BRAND_DOMAIN in u]
    rank, competitors = rank_of_brand(answer)
    j = {"sentiment": "", "recommended": False, "accurate": "", "inaccuracies": ""}
    if mentioned and (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("GEMINI_API_KEY")):
        try:
            j = judge(answer)
        except Exception as e:  # scoring must never stop the run
            j["inaccuracies"] = f"[judge error: {e}]"
    return {
        "mentioned": mentioned, "cited": bool(cited), "cited_urls": " ".join(dict.fromkeys(cited)),
        "rank": rank or "", "top3": bool(rank and rank <= 3), "competitors": ", ".join(competitors),
        "n_competitors": len(competitors), "all_urls": " ".join(dict.fromkeys(urls))[:4000], **j,
    }


# ------------------------------------------------------------------- sheet --

RESULT_COLS = ["Week", "Run date", "Engine", "Model", "Prompt ID", "Category", "Branded?", "Prompt",
               "Mentioned", "Cited", "Rank", "Top 3", "Recommended", "Sentiment", "Accurate",
               "Inaccuracies", "Safe Pro URLs cited", "Competitors named", "All cited URLs", "Answer", "Error"]
SCORE_COLS = ["Week", "Run date", "Engine", "Prompts run", "Mention rate", "Citation rate",
              "Top-3 rate", "Recommendation rate", "Share of voice", "Unique Safe Pro pages cited",
              "Entity accuracy", "Positive", "Neutral", "Negative", "Non-branded mention rate"]


def open_sheet():
    import gspread
    info = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
    return gspread.service_account_from_dict(info).open_by_key(SHEET_ID)


def tab(book, name, cols):
    import gspread
    try:
        ws = book.worksheet(name)
    except gspread.WorksheetNotFound:
        ws = book.add_worksheet(name, rows=1000, cols=len(cols))
        ws.append_row(cols)
        ws.freeze(rows=1)
    return ws


def load_prompts(book):
    rows = book.get_worksheet(0).get_all_records()
    return [r for r in rows if str(r.get("Active", "Yes")).strip().lower() != "no"]


def week_number(today):
    if not WEEK1_DATE:
        return 1
    start = dt.date.fromisoformat(WEEK1_DATE)
    return max(1, (today - start).days // 7 + 1)


def summarise(week, run_date, engine, rows):
    n = len(rows)
    if not n:
        return None
    pct = lambda k: round(100 * sum(1 for r in rows if r[k] is True) / n, 1)
    brand_hits = sum(1 for r in rows if r["mentioned"])
    comp_hits = sum(r["n_competitors"] for r in rows)
    judged = [r for r in rows if r["accurate"]]
    nb = [r for r in rows if r["Branded?"] != "Branded"]
    pages = {u for r in rows for u in r["cited_urls"].split() if u}
    return [week, run_date, engine, n, pct("mentioned"), pct("cited"), pct("top3"), pct("recommended"),
            round(100 * brand_hits / (brand_hits + comp_hits), 1) if brand_hits + comp_hits else 0,
            len(pages),
            round(100 * sum(1 for r in judged if r["accurate"] == "yes") / len(judged), 1) if judged else "",
            sum(1 for r in rows if r["sentiment"] == "positive"),
            sum(1 for r in rows if r["sentiment"] == "neutral"),
            sum(1 for r in rows if r["sentiment"] == "negative"),
            round(100 * sum(1 for r in nb if r["mentioned"]) / len(nb), 1) if nb else ""]


# -------------------------------------------------------------------- main --

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="only the first N prompts (for testing)")
    ap.add_argument("--engines", default="", help="comma list; default = every engine with a key")
    ap.add_argument("--dry-run", action="store_true", help="print results, don't write the sheet")
    ap.add_argument("--prompts-csv", default="", help="read prompts from a CSV instead of the sheet")
    args = ap.parse_args()

    today = dt.date.today()
    week, run_date = week_number(today), today.isoformat()

    book = None
    if args.prompts_csv:
        import csv
        with open(args.prompts_csv, newline="", encoding="utf-8") as f:
            prompts = [r for r in csv.DictReader(f) if r.get("Active", "Yes").lower() != "no"]
    else:
        book = open_sheet()
        prompts = load_prompts(book)
    if args.limit:
        prompts = prompts[: args.limit]

    wanted = [e.strip() for e in args.engines.split(",") if e.strip()] or list(ENGINES)
    engines = [e for e in wanted if os.environ.get(ENGINES[e][1])]
    skipped = [e for e in wanted if e not in engines]
    print(f"Week {week} | {len(prompts)} prompts | engines: {engines} | skipped (no key): {skipped}")

    results_ws = scores_ws = None
    if book and not args.dry_run:
        results_ws = tab(book, "Results", RESULT_COLS)
        scores_ws = tab(book, "Scores", SCORE_COLS)

    for engine in engines:
        fn = ENGINES[engine][0]
        rows, out = [], []
        for p in prompts:
            err, answer, urls = "", "", []
            for attempt in range(3):
                try:
                    answer, urls = fn(p["Prompt"])
                    if engine == "gemini":
                        time.sleep(float(os.environ.get("GEMINI_DELAY", "7")))  # stay under free-tier per-minute limit
                    err = ""
                    break
                except Exception as e:
                    err = f"{type(e).__name__}: {e}"[:500]
                    time.sleep(5 * (attempt + 1))
            s = score(answer, urls) if not err else score("", [])
            s["Branded?"] = p.get("Branded?", "")
            if not err:
                rows.append(s)
            out.append([week, run_date, engine, MODELS.get(engine, "serpapi"), p["Prompt ID"], p["Category"],
                        p.get("Branded?", ""), p["Prompt"], s["mentioned"], s["cited"], s["rank"], s["top3"],
                        s["recommended"], s["sentiment"], s["accurate"], s["inaccuracies"], s["cited_urls"],
                        s["competitors"], s["all_urls"], answer[:45000], err])
            print(f"  {engine:15} {p['Prompt ID']} mentioned={s['mentioned']!s:5} cited={s['cited']!s:5} {err[:80]}")
        summary = summarise(week, run_date, engine, rows)
        if results_ws:
            results_ws.append_rows(out, value_input_option="RAW")
            if summary:
                scores_ws.append_row(summary, value_input_option="RAW")
        elif summary:
            print("  SUMMARY:", dict(zip(SCORE_COLS, summary)))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
