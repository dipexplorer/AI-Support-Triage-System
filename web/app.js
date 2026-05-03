/**
 * app.js — AI Support Triage System Web UI
 *
 * Handles:
 *  - Health check polling on load
 *  - Single ticket /ask API call
 *  - Batch CSV upload to /batch endpoint
 *  - Drag-and-drop file handling
 *  - Results rendering (table + stats bar)
 *  - CSV download
 */

const API_BASE = window.location.origin;

// ── Global state ──────────────────────────────────────────────────────────────
let _batchCsvBlob = null;   // stores the downloaded CSV blob for later save
let _selectedFile  = null;  // the File object from the input / drop

// ── On Load ───────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  checkHealth();
  // Poll health every 30 seconds
  setInterval(checkHealth, 30_000);
});

// ── Health Check ──────────────────────────────────────────────────────────────
async function checkHealth() {
  const dot   = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  try {
    const res  = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data.bm25_ready) {
      dot.className   = 'status-dot ready';
      label.textContent = `Ready · ${data.corpus_domains.join(', ')}`;
    } else {
      dot.className   = 'status-dot';
      label.textContent = 'Index building…';
    }
  } catch {
    dot.className   = 'status-dot error';
    label.textContent = 'Server offline';
  }
}

// ── Tab Switch ────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('panelSingle').classList.toggle('hidden', tab !== 'single');
  document.getElementById('panelBatch').classList.toggle('hidden',  tab !== 'batch');
  document.getElementById('tabSingle').classList.toggle('active', tab === 'single');
  document.getElementById('tabBatch').classList.toggle('active',  tab === 'batch');
}

// ── Single Ticket ─────────────────────────────────────────────────────────────
async function submitSingle(event) {
  event.preventDefault();

  const issue   = document.getElementById('issue').value.trim();
  const subject = document.getElementById('subject').value.trim();
  const company = document.getElementById('company').value;

  if (!issue) { showToast('Please enter the ticket issue.', 'error'); return; }

  setLoading('submitBtn', 'btnSpinner', true);

  try {
    const res = await fetch(`${API_BASE}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue, subject, company }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    renderSingleResult(data);
    updateStats(1, data.status === 'replied' ? 1 : 0, data.status === 'escalated' ? 1 : 0);
    showToast('Ticket triaged successfully!', 'success');

  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  } finally {
    setLoading('submitBtn', 'btnSpinner', false);
  }
}

function renderSingleResult(data) {
  document.getElementById('resultEmpty').classList.add('hidden');
  const content = document.getElementById('resultContent');
  content.classList.remove('hidden');

  // Badge
  const badge = document.getElementById('resultBadge');
  badge.textContent  = data.status.toUpperCase();
  badge.className    = `badge badge-${data.status}`;

  // Meta
  document.getElementById('resRequestType').textContent = data.request_type.replace('_', ' ');
  document.getElementById('resProductArea').textContent  = data.product_area.replace(/_/g, ' ');

  // Response and justification
  document.getElementById('resResponse').textContent      = data.response;
  document.getElementById('resJustification').textContent = data.justification;
}

// ── Batch CSV ─────────────────────────────────────────────────────────────────
function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('dropZone').classList.add('dragging');
}
function handleDragLeave() {
  document.getElementById('dropZone').classList.remove('dragging');
}
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('dropZone').classList.remove('dragging');
  const file = e.dataTransfer.files?.[0];
  if (file) applyFile(file);
}
function handleFileSelect(e) {
  const file = e.target.files?.[0];
  if (file) applyFile(file);
}

function applyFile(file) {
  if (!file.name.endsWith('.csv')) {
    showToast('Please select a .csv file.', 'error');
    return;
  }
  _selectedFile = file;

  document.getElementById('dropText').textContent = 'File ready';
  document.getElementById('dropSub').textContent  = 'Click to change';
  document.getElementById('dropIcon').innerHTML   =
    `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;

  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = formatBytes(file.size);
  document.getElementById('batchActions').style.display = 'flex';
  document.getElementById('batchResultCard').classList.add('hidden');
}

function clearFile() {
  _selectedFile = null;
  _batchCsvBlob = null;
  document.getElementById('csvFile').value = '';
  document.getElementById('batchActions').style.display = 'none';
  document.getElementById('progressWrap').classList.add('hidden');
  document.getElementById('batchResultCard').classList.add('hidden');
  document.getElementById('dropText').textContent = 'Drag & drop your CSV here';
  document.getElementById('dropSub').textContent  = 'or click to browse';
  document.getElementById('dropIcon').innerHTML   =
    `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
}

async function processBatch() {
  if (!_selectedFile) { showToast('Please select a CSV file first.', 'error'); return; }

  setLoading('processBtn', 'batchSpinner', true);

  const progress = document.getElementById('progressWrap');
  const fill     = document.getElementById('progressFill');
  const plabel   = document.getElementById('progressLabel');

  progress.classList.remove('hidden');
  fill.style.width    = '0%';
  plabel.textContent  = 'Uploading CSV…';

  // Animate progress (fake — real progress isn't available from fetch streaming)
  const fakeProgress = animateProgress(fill, plabel);

  const t0  = Date.now();
  const fd  = new FormData();
  fd.append('file', _selectedFile);

  try {
    const res = await fetch(`${API_BASE}/batch`, { method: 'POST', body: fd });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Server error' }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const csvText = await res.text();
    clearInterval(fakeProgress);
    fill.style.width   = '100%';
    plabel.textContent = 'Done!';

    _batchCsvBlob = new Blob([csvText], { type: 'text/csv' });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    renderBatchResult(csvText, elapsed);
    showToast('Batch processed! Download your results.', 'success');

  } catch (e) {
    clearInterval(fakeProgress);
    showToast(`Batch error: ${e.message}`, 'error');
  } finally {
    setLoading('processBtn', 'batchSpinner', false);
  }
}

function animateProgress(fill, label) {
  let pct = 0;
  return setInterval(() => {
    pct = Math.min(pct + Math.random() * 8, 88);
    fill.style.width  = `${pct}%`;
    label.textContent = `Processing… ${Math.round(pct)}%`;
  }, 400);
}

function renderBatchResult(csvText, elapsed) {
  const lines  = csvText.trim().split('\n');
  if (lines.length < 2) { showToast('Empty result CSV.', 'error'); return; }

  const headers = parseCSVLine(lines[0]);
  const rows    = lines.slice(1).map(parseCSVLine);

  // Stats
  const statusIdx   = headers.findIndex(h => h === 'status');
  const replied     = rows.filter(r => r[statusIdx] === 'replied').length;
  const escalated   = rows.filter(r => r[statusIdx] === 'escalated').length;
  updateStats(rows.length, replied, escalated, elapsed + 's');

  // Table headers
  const displayCols = ['issue', 'company', 'status', 'product_area', 'request_type', 'justification'];
  const colIdxMap   = displayCols.map(c => headers.findIndex(h => h.trim().toLowerCase() === c));

  const thead = document.getElementById('tableHead');
  thead.innerHTML = `<tr>${displayCols.map(c =>
    `<th>${c.replace(/_/g,' ')}</th>`
  ).join('')}</tr>`;

  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = rows.map(row => `
    <tr>
      ${colIdxMap.map((ci, i) => {
        const val = ci >= 0 ? (row[ci] || '—') : '—';
        const col = displayCols[i];
        if (col === 'status') {
          const cls = val === 'replied' ? 'cell-replied' : 'cell-escalated';
          return `<td><span class="cell-badge ${cls}">${val}</span></td>`;
        }
        return `<td class="truncate" title="${escHtml(val)}">${escHtml(val.slice(0,80))}${val.length>80?'…':''}</td>`;
      }).join('')}
    </tr>
  `).join('');

  document.getElementById('batchResultCard').classList.remove('hidden');
  document.getElementById('batchResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function downloadResult() {
  if (!_batchCsvBlob) return;
  const url  = URL.createObjectURL(_batchCsvBlob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `triage_result_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Stats Bar ─────────────────────────────────────────────────────────────────
function updateStats(total, replied, escalated, time = '—') {
  document.getElementById('statsBar').style.display   = 'grid';
  document.getElementById('statTotal').textContent    = total;
  document.getElementById('statReplied').textContent  = replied;
  document.getElementById('statEscalated').textContent = escalated;
  document.getElementById('statTime').textContent     = time;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function setLoading(btnId, spinnerId, loading) {
  const btn     = document.getElementById(btnId);
  const spinner = document.getElementById(spinnerId);
  const text    = btn.querySelector('.btn-text');
  btn.disabled  = loading;
  spinner.classList.toggle('hidden', !loading);
  if (text) text.style.opacity = loading ? '0' : '1';
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = `toast ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1024/1024).toFixed(1)} MB`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Minimal RFC 4180 CSV line parser (handles quoted fields with commas/newlines). */
function parseCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
