/**
 * SAFE PRO AEO Tracker — runs inside the Google Sheet (free, Gemini).
 *
 * Setup (once):
 *   1. In the sheet: Extensions → Apps Script. Delete what's there, paste this whole file, Save.
 *   2. Reload the sheet. A new menu "AEO Tracker" appears.
 *   3. AEO Tracker → 1. Save Gemini key   (paste your key; it is stored privately in the script)
 *   4. AEO Tracker → 2. Test run (10 prompts)
 *   5. AEO Tracker → 3. Turn on weekly schedule  (every Monday ~9 AM)
 *
 * Tabs: first tab = prompts (Prompt ID, Category, Branded?, Prompt, Active).
 *       "Results" = one row per prompt per week. "Scores" = one row per week.
 */

const CONFIG = {
  model: '',               // blank = pick Google's newest free Flash model automatically
  brandRegex: /\bsafe\s*-?\s*pro\b/i,
  brandDomain: 'safeprofire.com',
  competitors: ['Ceasefire', 'Safex', 'Kanex', 'Minimax', 'Supremex', 'New Age',
                'Impact Fire', 'Usha Fire', 'HD Fire', 'Firepro'],
  delayMs: 7000,            // pause between Gemini calls (free tier per-minute limit)
  batchMs: 4.5 * 60 * 1000, // Apps Script stops at 6 min, so work in ~4.5 min batches
  facts: 'Safe Pro Fire Services Pvt. Ltd.: fire-safety equipment manufacturer, founded 2000, ' +
         'HQ Kurla West, Mumbai; plant in Bhiwandi; 50,000+ customers; 120 products across 15 ' +
         'categories; branches across 16 Indian states; website safeprofire.com.',
  systemHint: 'The user is in India. Answer the question as you normally would, naming specific companies or brands where relevant.',
};

const RESULT_COLS = ['Week', 'Run date', 'Engine', 'Prompt ID', 'Category', 'Branded?', 'Prompt',
  'Mentioned', 'Cited', 'Rank', 'Top 3', 'Recommended', 'Sentiment', 'Accurate', 'Inaccuracies',
  'Safe Pro URLs cited', 'Competitors named', 'Sources', 'Answer', 'Error'];
const SCORE_COLS = ['Week', 'Run date', 'Engine', 'Prompts run', 'Mention rate %', 'Citation rate %',
  'Top-3 rate %', 'Recommendation rate %', 'Share of voice %', 'Unique Safe Pro pages cited',
  'Entity accuracy %', 'Positive', 'Neutral', 'Negative', 'Non-branded mention rate %'];

const props = PropertiesService.getScriptProperties();

// ------------------------------------------------------------------ menu --

function onOpen() {
  SpreadsheetApp.getUi().createMenu('AEO Tracker')
    .addItem('1. Save Gemini key', 'saveKey')
    .addItem('2. Test run (10 prompts)', 'testRun')
    .addItem('3. Turn on weekly schedule', 'turnOnSchedule')
    .addSeparator()
    .addItem('Run all prompts now', 'fullRun')
    .addItem('Turn off weekly schedule', 'turnOffSchedule')
    .addItem('Show status', 'showStatus')
    .addItem('Reset model choice', 'resetModels')
    .addToUi();
}

function saveKey() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Gemini API key', 'Paste your key from aistudio.google.com. It is stored privately in this script.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK || !r.getResponseText().trim()) return;
  props.setProperty('GEMINI_API_KEY', r.getResponseText().trim());
  ui.alert('Saved. Next: AEO Tracker → 2. Test run (10 prompts).');
}

function testRun() { ['CANDIDATES', 'MODEL_INDEX', 'MODEL', 'NO_SEARCH'].forEach(k => props.deleteProperty(k)); startRun_(10, true); }
function fullRun() { startRun_(0, false); }

function turnOnSchedule() {
  turnOffSchedule_(['weeklyRun']);
  ScriptApp.newTrigger('weeklyRun').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).inTimezone('Asia/Kolkata').create();
  SpreadsheetApp.getUi().alert('Weekly schedule is on: every Monday around 9 AM India time.');
}

function turnOffSchedule() {
  turnOffSchedule_(['weeklyRun', 'continueRun']);
  SpreadsheetApp.getUi().alert('Weekly schedule is off.');
}

function showStatus() {
  const s = JSON.parse(props.getProperty('RUN') || 'null');
  const msg = !s ? 'No run in progress.' :
    `Week ${s.week} run: ${s.next} of ${s.total} prompts done${s.done ? ' (finished)' : ''}.`;
  SpreadsheetApp.getUi().alert(msg + '\nModel: ' + (props.getProperty('MODEL') || 'not picked yet') + (props.getProperty('NO_SEARCH') ? ' (no web search)' : '') + '\nWeek 1 date: ' + (props.getProperty('WEEK1_DATE') || 'not set yet'));
}

function weeklyRun() { startRun_(0, false); }

// ------------------------------------------------------------- run logic --

function startRun_(limit, isTest) {
  if (!props.getProperty('GEMINI_API_KEY')) throw new Error('Save your Gemini key first (AEO Tracker → 1).');
  const today = new Date();
  if (!isTest && !props.getProperty('WEEK1_DATE')) props.setProperty('WEEK1_DATE', ymd_(today));
  const week1 = props.getProperty('WEEK1_DATE');
  const week = isTest ? 'TEST' : (week1 ? Math.floor((today - new Date(week1)) / (7 * 864e5)) + 1 : 1);
  const prompts = loadPrompts_();
  const total = limit ? Math.min(limit, prompts.length) : prompts.length;
  props.setProperty('RUN', JSON.stringify({week: week, date: ymd_(today), next: 0, total: total, done: false}));
  continueRun();
}

function continueRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const s = JSON.parse(props.getProperty('RUN') || 'null');
    if (!s || s.done) { turnOffSchedule_(['continueRun']); return; }
    const started = Date.now();
    const prompts = loadPrompts_();
    const results = tab_('Results', RESULT_COLS);
    while (s.next < s.total && Date.now() - started < CONFIG.batchMs) {
      const p = prompts[s.next];
      results.appendRow(runOne_(p, s));
      s.next++;
      props.setProperty('RUN', JSON.stringify(s));
    }
    if (s.next >= s.total) {
      s.done = true;
      props.setProperty('RUN', JSON.stringify(s));
      turnOffSchedule_(['continueRun']);
      writeScores_(s);
    } else if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'continueRun')) {
      ScriptApp.newTrigger('continueRun').timeBased().everyMinutes(5).create();
    }
  } finally {
    lock.releaseLock();
  }
}

function runOne_(p, s) {
  let answer = '', sources = [], err = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try { [answer, sources] = askGemini_(p['Prompt']); err = ''; break; }
    catch (e) { err = String(e).slice(0, 400); Utilities.sleep(15000 * (attempt + 1)); }
  }
  Utilities.sleep(CONFIG.delayMs);
  const sc = score_(answer, sources);
  return [s.week, s.date, modelName_(), p['Prompt ID'], p['Category'], p['Branded?'], p['Prompt'],
    sc.mentioned, sc.cited, sc.rank, sc.top3, sc.recommended, sc.sentiment, sc.accurate, sc.inaccuracies,
    sc.citedUrls, sc.competitors.join(', '), sources.join(' ').slice(0, 4000), answer.slice(0, 45000), err];
}

// ---------------------------------------------------------------- gemini --

// Free-plan Gemini access differs by model and changes often, so the script keeps a list
// of candidate models and moves down it when Google says a model is not free.
function candidates_() {
  const cached = props.getProperty('CANDIDATES');
  if (cached) return JSON.parse(cached);
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    {headers: {'x-goog-api-key': props.getProperty('GEMINI_API_KEY')}, muteHttpExceptions: true});
  if (res.getResponseCode() !== 200) throw new Error('Gemini model list ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  const bad = /image|tts|live|audio|embed|thinking|exp|preview|learnlm|robotics|computer|native/i;
  const names = (JSON.parse(res.getContentText()).models || [])
    .filter(x => (x.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
    .map(x => x.name.replace('models/', ''))
    .filter(n => /^gemini-[\d.]+-flash/.test(n) && !bad.test(n));
  const ver = n => parseFloat(n.split('-')[1]);
  // full Flash models newest first, then Lite models newest first, then Google's aliases
  names.sort((a, b) => (/lite/.test(a) - /lite/.test(b)) || ver(b) - ver(a) || a.length - b.length);
  const list = Array.from(new Set((CONFIG.model ? [CONFIG.model] : []).concat(names, ['gemini-flash-latest', 'gemini-flash-lite-latest'])));
  props.setProperty('CANDIDATES', JSON.stringify(list));
  return list;
}

function modelName_() {
  const list = candidates_();
  const i = Number(props.getProperty('MODEL_INDEX') || 0);
  return list[Math.min(i, list.length - 1)];
}

function nextModel_() {
  const list = candidates_();
  const i = Number(props.getProperty('MODEL_INDEX') || 0) + 1;
  if (i >= list.length) return false;
  props.setProperty('MODEL_INDEX', String(i));
  props.setProperty('MODEL', list[i]);
  return true;
}

function gemini_(body) {
  for (let tries = 0; tries < 40; tries++) {
    const model = modelName_();
    props.setProperty('MODEL', model);
    const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: {'x-goog-api-key': props.getProperty('GEMINI_API_KEY')},
      payload: JSON.stringify(body),
    });
    const code = res.getResponseCode(), text = res.getContentText();
    if (code === 200) return JSON.parse(text);
    const notFree = code === 404 || code === 403 || (code === 429 && /limit:\s*0\b|billing|plan/i.test(text) && !/per.?minute/i.test(text));
    if (notFree) {
      if (nextModel_()) continue;
      // Every model refused with web search on: carry on without search as a last resort.
      if (body.tools && !props.getProperty('NO_SEARCH')) {
        props.setProperty('NO_SEARCH', '1'); props.setProperty('MODEL_INDEX', '0'); continue;
      }
    }
    if (code === 429 && tries < 3) { Utilities.sleep(30000); continue; }   // per-minute limit: wait and retry
    throw new Error('Gemini ' + code + ' (' + model + '): ' + text.slice(0, 300));
  }
  throw new Error('Gemini: no model worked');
}

function resetModels() {
  ['CANDIDATES', 'MODEL_INDEX', 'MODEL', 'NO_SEARCH'].forEach(k => props.deleteProperty(k));
  SpreadsheetApp.getUi().alert('Model choice reset. The next run will look for a free Gemini model again.');
}

function askGemini_(prompt) {
  const d = gemini_({
    systemInstruction: {parts: [{text: CONFIG.systemHint}]},
    contents: [{role: 'user', parts: [{text: prompt}]}],
    tools: props.getProperty('NO_SEARCH') ? undefined : [{google_search: {}}],
  });
  const cand = (d.candidates || [{}])[0];
  const text = ((cand.content || {}).parts || []).map(x => x.text || '').join('');
  // Gemini gives redirect links; the title holds the real site name.
  const sources = (((cand.groundingMetadata || {}).groundingChunks) || [])
    .map(c => (c.web && (c.web.title || c.web.uri)) || '').filter(String);
  if (props.getProperty('NO_SEARCH')) sources.unshift('[answered without web search]');
  return [text, sources];
}

function judge_(answer) {
  const d = gemini_({
    contents: [{role: 'user', parts: [{text:
      'Verified facts about the brand:\n' + CONFIG.facts + '\n\nAI answer to score:\n<answer>\n' +
      answer.slice(0, 12000) + '\n</answer>\n\nHow does this answer portray Safe Pro (sentiment)? ' +
      'Does it recommend Safe Pro? Are its statements about Safe Pro consistent with the verified facts? ' +
      "List any inaccuracies briefly, or ''."}]}],
    generationConfig: {responseMimeType: 'application/json', responseSchema: {
      type: 'object',
      properties: {
        sentiment: {type: 'string', enum: ['positive', 'neutral', 'negative']},
        recommended: {type: 'boolean'},
        accurate: {type: 'string', enum: ['yes', 'no', 'partly']},
        inaccuracies: {type: 'string'},
      },
      required: ['sentiment', 'recommended', 'accurate', 'inaccuracies'],
    }},
  });
  Utilities.sleep(CONFIG.delayMs);
  return JSON.parse(d.candidates[0].content.parts[0].text);
}

// --------------------------------------------------------------- scoring --

function escape_(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*'); }

function score_(answer, sources) {
  const urls = sources.concat(answer.match(/https?:\/\/[^\s)\]}>"']+/g) || []);
  const cited = urls.filter(u => u.indexOf(CONFIG.brandDomain) >= 0);
  const m = answer.match(CONFIG.brandRegex);
  const mentioned = !!m || cited.length > 0;
  const hits = [];
  if (m) hits.push([m.index, 'Safe Pro']);
  CONFIG.competitors.forEach(c => {
    const mm = answer.match(new RegExp('\\b' + escape_(c) + '\\b', 'i'));
    if (mm) hits.push([mm.index, c]);
  });
  hits.sort((a, b) => a[0] - b[0]);
  const names = hits.map(h => h[1]);
  const rank = names.indexOf('Safe Pro') + 1 || '';
  let j = {sentiment: '', recommended: false, accurate: '', inaccuracies: ''};
  if (mentioned && answer) {
    try { j = judge_(answer); } catch (e) { j.inaccuracies = '[scoring error: ' + String(e).slice(0, 200) + ']'; }
  }
  return {mentioned: mentioned, cited: cited.length > 0, citedUrls: Array.from(new Set(cited)).join(' '),
    rank: rank, top3: !!rank && rank <= 3, competitors: names.filter(n => n !== 'Safe Pro'),
    sentiment: j.sentiment, recommended: j.recommended, accurate: j.accurate, inaccuracies: j.inaccuracies};
}

function writeScores_(s) {
  const data = tab_('Results', RESULT_COLS).getDataRange().getValues();
  const head = data.shift();
  const col = n => head.indexOf(n);
  const sameDate = v => (v instanceof Date ? ymd_(v) : String(v)) === s.date;
  const rows = data.filter(r => String(r[col('Week')]) === String(s.week) &&
    sameDate(r[col('Run date')]) && !r[col('Error')]);
  const n = rows.length;
  if (!n) return;
  const t = v => v === true || v === 'TRUE';
  const pct = (arr, f) => arr.length ? Math.round(1000 * arr.filter(f).length / arr.length) / 10 : '';
  const brand = rows.filter(r => t(r[col('Mentioned')])).length;
  const comps = rows.reduce((a, r) => a + (r[col('Competitors named')] ? String(r[col('Competitors named')]).split(', ').length : 0), 0);
  const judged = rows.filter(r => r[col('Accurate')]);
  const nb = rows.filter(r => r[col('Branded?')] !== 'Branded');
  const pages = new Set();
  rows.forEach(r => String(r[col('Safe Pro URLs cited')] || '').split(' ').filter(String).forEach(u => pages.add(u)));
  tab_('Scores', SCORE_COLS).appendRow([s.week, s.date, 'gemini', n,
    pct(rows, r => t(r[col('Mentioned')])), pct(rows, r => t(r[col('Cited')])),
    pct(rows, r => t(r[col('Top 3')])), pct(rows, r => t(r[col('Recommended')])),
    brand + comps ? Math.round(1000 * brand / (brand + comps)) / 10 : 0, pages.size,
    pct(judged, r => r[col('Accurate')] === 'yes'),
    rows.filter(r => r[col('Sentiment')] === 'positive').length,
    rows.filter(r => r[col('Sentiment')] === 'neutral').length,
    rows.filter(r => r[col('Sentiment')] === 'negative').length,
    pct(nb, r => t(r[col('Mentioned')]))]);
}

// --------------------------------------------------------------- helpers --

function loadPrompts_() {
  const values = SpreadsheetApp.getActive().getSheets()[0].getDataRange().getValues();
  const head = values.shift();
  return values.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])))
    .filter(p => p['Prompt'] && String(p['Active'] || 'Yes').trim().toLowerCase() !== 'no');
}

function tab_(name, cols) {
  const book = SpreadsheetApp.getActive();
  let sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(cols); sh.setFrozenRows(1); }
  return sh;
}

function turnOffSchedule_(handlers) {
  ScriptApp.getProjectTriggers().filter(t => handlers.indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function ymd_(d) { return Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd'); }
