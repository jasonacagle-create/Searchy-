<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Medical Assistant Textbook Search</title>
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
<style>
  :root {
    --navy: #0f2340;
    --teal: #1a6b72;
    --gold: #c8972a;
    --cream: #f8f5ef;
    --soft: #e8e2d8;
    --text: #1c2b3a;
    --muted: #6b7a8d;
    --white: #ffffff;
    --highlight: #fff3c4;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: Arial, sans-serif;
    background: var(--cream);
    color: var(--text);
    min-height: 100vh;
  }

  header {
    background: var(--navy);
    color: var(--white);
    padding: 16px 20px;
  }

  header h1 {
    font-size: 1.3rem;
    margin-bottom: 4px;
  }

  .search-wrap {
    background: var(--navy);
    padding: 0 20px 16px;
  }

  .search-row, .upload-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 10px;
  }

  input[type="text"], select, button, input[type="file"] {
    padding: 10px 12px;
    font-size: 16px;
    border-radius: 8px;
    border: 1px solid #ccc;
  }

  input[type="text"] {
    flex: 1;
    min-width: 220px;
  }

  button {
    background: var(--teal);
    color: white;
    border: none;
    cursor: pointer;
  }

  .stats {
    background: var(--soft);
    padding: 10px 20px;
    font-size: 0.9rem;
    color: var(--muted);
  }

  .main {
    max-width: 1000px;
    margin: 0 auto;
    padding: 20px;
  }

  .result-card {
    background: white;
    border: 1px solid #ddd;
    border-radius: 10px;
    margin-bottom: 12px;
    overflow: hidden;
  }

  .card-header {
    background: #f7f5f0;
    padding: 10px 14px;
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    border-bottom: 1px solid #eee;
  }

  .badge {
    background: var(--navy);
    color: white;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: 700;
  }

  .page-badge {
    background: #e8f4f8;
    color: var(--teal);
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: 700;
  }

  .card-body {
    padding: 14px;
    line-height: 1.6;
  }

  mark {
    background: var(--highlight);
  }

  .status {
    margin-top: 10px;
    font-size: 0.9rem;
    color: #d8e3ef;
  }
</style>
</head>
<body>
  <header>
    <h1>Medical Assistant Textbook Search</h1>
    <div>Search words, sentences, and import multiple textbook photos</div>
  </header>

  <div class="search-wrap">
    <div class="search-row">
      <input type="text" id="searchInput" placeholder="Search terms or exact phrases..." />
      <select id="mode">
        <option value="any">Any Word</option>
        <option value="all">All Words</option>
        <option value="exact">Exact Phrase</option>
      </select>
      <button id="searchBtn">Search</button>
    </div>

    <div class="upload-row">
      <input type="file" id="imageUpload" accept="image/*" capture="environment" multiple />
      <button id="scanBtn">Scan Photos</button>
    </div>

    <div class="status" id="status">Ready.</div>
  </div>

  <div class="stats" id="statsBar">0 results</div>
  <div class="main" id="results"></div>

<script>
  let textbookData = JSON.parse(localStorage.getItem("textbookData") || "[]");

  const searchInput = document.getElementById("searchInput");
  const modeSelect = document.getElementById("mode");
  const resultsEl = document.getElementById("results");
  const statsBar = document.getElementById("statsBar");
  const statusEl = document.getElementById("status");

  function saveData() {
    localStorage.setItem("textbookData", JSON.stringify(textbookData));
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalizeText(text) {
    return text
      .replace(/\s+/g, " ")
      .replace(/[|]/g, "I")
      .trim();
  }

  function highlight(text, query, mode) {
    if (!query.trim()) return text;

    const terms = mode === "exact"
      ? [query.trim()]
      : query.trim().split(/\s+/).filter(Boolean);

    const safeTerms = [...new Set(terms)]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp);

    if (!safeTerms.length) return text;

    const regex = new RegExp(`(${safeTerms.join("|")})`, "gi");
    return text.replace(regex, "<mark>$1</mark>");
  }

  function matches(text, query, mode) {
    const q = query.trim().toLowerCase();
    if (!q) return false;

    const lower = text.toLowerCase();

    if (mode === "exact") {
      return lower.includes(q);
    }

    const words = q.split(/\s+/).filter(Boolean);

    if (mode === "all") {
      return words.every(w => lower.includes(w));
    }

    return words.some(w => lower.includes(w));
  }

  function searchData() {
    const query = searchInput.value.trim();
    const mode = modeSelect.value;

    if (!query) {
      resultsEl.innerHTML = "";
      statsBar.textContent = "0 results";
      return;
    }

    const results = [];

    for (const page of textbookData) {
      if (matches(page.content, query, mode)) {
        results.push(page);
      }
    }

    statsBar.textContent = `${results.length} result${results.length === 1 ? "" : "s"}`;

    resultsEl.innerHTML = results.map(r => `
      <div class="result-card">
        <div class="card-header">
          <span class="badge">Ch ${r.chapter || "?"}</span>
          <span class="page-badge">p. ${r.page || "?"}</span>
          <span>${r.title || "Imported Page"}</span>
        </div>
        <div class="card-body">${highlight(r.content, query, mode)}</div>
      </div>
    `).join("");
  }

  function detectChapter(text) {
    const patterns = [
      /\bchapter\s+(\d{1,2})\b/i,
      /\bch\.?\s*(\d{1,2})\b/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return Number(match[1]);
    }

    return null;
  }

  function detectPage(text) {
    const lines = text
      .split(/\n+/)
      .map(l => l.trim())
      .filter(Boolean);

    const pageCandidates = [];

    lines.forEach((line, index) => {
      const clean = line.replace(/[^\d]/g, "");
      if (/^\d{1,4}$/.test(clean)) {
        const score =
          (index < 3 ? 3 : 0) +
          (index >= lines.length - 3 ? 3 : 0) +
          (clean.length >= 2 && clean.length <= 4 ? 2 : 0);

        pageCandidates.push({ value: Number(clean), score });
      }
    });

    if (pageCandidates.length) {
      pageCandidates.sort((a, b) => b.score - a.score);
      return pageCandidates[0].value;
    }

    const allStandalone = [...text.matchAll(/\b(\d{2,4})\b/g)]
      .map(m => Number(m[1]))
      .filter(n => n >= 1 && n <= 2000);

    return allStandalone.length ? allStandalone[0] : null;
  }

  function buildTitle(chapter) {
    return chapter ? `Chapter ${chapter}` : "Imported Page";
  }

  async function processImages() {
    const files = Array.from(document.getElementById("imageUpload").files || []);
    if (!files.length) {
      alert("Pick one or more photos first.");
      return;
    }

    statusEl.textContent = `Scanning ${files.length} image${files.length === 1 ? "" : "s"}...`;
    resultsEl.innerHTML = "";

    let added = 0;
    let failed = 0;

    for (const file of files) {
      try {
        statusEl.textContent = `Scanning ${file.name}...`;

        const {
          data: { text }
        } = await Tesseract.recognize(file, "eng");

        const cleaned = normalizeText(text);
        const chapter = detectChapter(text);
        const page = detectPage(text);

        textbookData.push({
          id: crypto.randomUUID(),
          chapter: chapter,
          page: page,
          title: buildTitle(chapter),
          content: cleaned,
          rawText: text,
          fileName: file.name,
          createdAt: new Date().toISOString()
        });

        added++;
      } catch (err) {
        console.error("OCR failed for", file.name, err);
        failed++;
      }
    }

    saveData();

    statusEl.textContent =
      `Done. Added ${added} page${added === 1 ? "" : "s"}`
      + (failed ? `, ${failed} failed.` : ".");

    document.getElementById("imageUpload").value = "";

    if (searchInput.value.trim()) {
      searchData();
    }
  }

  document.getElementById("searchBtn").addEventListener("click", searchData);
  document.getElementById("scanBtn").addEventListener("click", processImages);
  searchInput.addEventListener("input", searchData);
  modeSelect.addEventListener("change", searchData);
</script>
</body>
</html>
