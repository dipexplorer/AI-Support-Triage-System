/**
 * app.js — AI Support Triage System Web UI (v2 — with History & Analytics)
 */

const API_BASE = window.location.origin;

// ── State ─────────────────────────────────────────────────────────────────────
let _batchCsvBlob   = null;
let _selectedFile   = null;
let _sessionTotal   = 0;
let _sessionReplied = 0;
let _sessionEscalated = 0;
// Chart.js instances
let _chartStatus  = null;
let _chartCompany = null;
let _chartTypes   = null;
let _chartDaily   = null;

// ── Chart.js Global Defaults ──────────────────────────────────────────────────
Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
Chart.defaults.font.size   = 12;

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  checkHealth();
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
      dot.className     = 'status-dot ready';
      label.textContent = `Ready · ${data.corpus_domains.join(', ')}`;
    } else {
      dot.className     = 'status-dot';
      label.textContent = 'Index building…';
    }
    // Show total triaged in header
    if (data.total_triaged > 0) {
      document.getElementById('headerTotal').style.display = 'flex';
      document.getElementById('headerTotalVal').textContent = data.total_triaged.toLocaleString();
    }
  } catch {
    dot.className     = 'status-dot error';
    label.textContent = 'Server offline';
  }
}

// ── Tab Switch ────────────────────────────────────────────────────────────────
function switchTab(tab) {
  ['single','batch','history','analytics','corpus'].forEach(t => {
    document.getElementById(`panel${cap(t)}`).classList.toggle('hidden', t !== tab);
    document.getElementById(`tab${cap(t)}`).classList.toggle('active', t === tab);
  });
  if (tab === 'history')   loadHistory();
  if (tab === 'analytics') loadAnalytics();
  if (tab === 'corpus')    loadCorpus();
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// ── Single Ticket ─────────────────────────────────────────────────────────────
async function submitSingle(event) {
  event.preventDefault();
  const issue   = document.getElementById('issue').value.trim();
  const subject = document.getElementById('subject').value.trim();
  const company = document.getElementById('company').value;
  if (!issue) { showToast('Please enter the ticket issue.', 'error'); return; }

  setLoading('submitBtn', 'btnSpinner', true);
  const t0 = Date.now();
  try {
    const res = await fetch(`${API_BASE}/ask`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ issue, subject, company }),
    });
    if (!res.ok) { const e = await res.json().catch(()=>({detail:'Unknown'})); throw new Error(e.detail); }
    const data = await res.json();
    renderSingleResult(data);
    const elapsed = ((Date.now()-t0)/1000).toFixed(1)+'s';
    _sessionTotal++;
    data.status === 'replied' ? _sessionReplied++ : _sessionEscalated++;
    updateStats(_sessionTotal, _sessionReplied, _sessionEscalated, elapsed);
    checkHealth();  // refresh header counter
    showToast('Ticket triaged!', 'success');
  } catch(e) {
    showToast(`Error: ${e.message}`, 'error');
  } finally {
    setLoading('submitBtn', 'btnSpinner', false);
  }
}

function renderSingleResult(data) {
  document.getElementById('resultEmpty').classList.add('hidden');
  document.getElementById('resultContent').classList.remove('hidden');
  const badge = document.getElementById('resultBadge');
  badge.textContent = data.status.toUpperCase();
  badge.className   = `badge badge-${data.status}`;
  document.getElementById('resRequestType').textContent = data.request_type.replace(/_/g,' ');
  document.getElementById('resProductArea').textContent  = data.product_area.replace(/_/g,' ');
  // Render markdown in the response
  document.getElementById('resResponse').innerHTML      = md2html(data.response);
  document.getElementById('resJustification').textContent = data.justification;
  // Store ticket_id for feedback and reset the feedback UI
  _lastTicketId = data.ticket_id || 0;
  resetFeedbackUI();
}

// ── Batch ─────────────────────────────────────────────────────────────────────
function handleDragOver(e)  { e.preventDefault(); document.getElementById('dropZone').classList.add('dragging'); }
function handleDragLeave()  { document.getElementById('dropZone').classList.remove('dragging'); }
function handleDrop(e)      { e.preventDefault(); document.getElementById('dropZone').classList.remove('dragging'); const f=e.dataTransfer.files?.[0]; if(f) applyFile(f); }
function handleFileSelect(e){ const f=e.target.files?.[0]; if(f) applyFile(f); }

function applyFile(file) {
  if (!file.name.endsWith('.csv')) { showToast('Please select a .csv file.','error'); return; }
  _selectedFile = file;
  document.getElementById('dropText').textContent = 'File ready';
  document.getElementById('dropSub').textContent  = 'Click to change';
  document.getElementById('dropIcon').innerHTML = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = formatBytes(file.size);
  document.getElementById('batchActions').style.display = 'flex';
  document.getElementById('batchResultCard').classList.add('hidden');
}

function clearFile() {
  _selectedFile = null; _batchCsvBlob = null;
  document.getElementById('csvFile').value = '';
  document.getElementById('batchActions').style.display = 'none';
  document.getElementById('progressWrap').classList.add('hidden');
  document.getElementById('batchResultCard').classList.add('hidden');
  document.getElementById('dropText').textContent = 'Drag & drop your CSV here';
  document.getElementById('dropSub').textContent  = 'or click to browse';
  document.getElementById('dropIcon').innerHTML = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
}

async function processBatch() {
  if (!_selectedFile) { showToast('Please select a CSV file first.','error'); return; }
  setLoading('processBtn','batchSpinner',true);
  const progress = document.getElementById('progressWrap');
  const fill     = document.getElementById('progressFill');
  const plabel   = document.getElementById('progressLabel');
  progress.classList.remove('hidden');
  fill.style.width = '0%';
  plabel.textContent = 'Uploading CSV…';
  const fakeProgress = animateProgress(fill, plabel);
  const t0  = Date.now();
  const fd  = new FormData();
  fd.append('file', _selectedFile);
  try {
    const res = await fetch(`${API_BASE}/batch`, { method:'POST', body:fd });
    if (!res.ok) { const e=await res.json().catch(()=>({detail:'Server error'})); throw new Error(e.detail); }
    const csvText = await res.text();
    clearInterval(fakeProgress);
    fill.style.width = '100%'; plabel.textContent = 'Done!';
    _batchCsvBlob = new Blob([csvText],{type:'text/csv'});
    const elapsed = ((Date.now()-t0)/1000).toFixed(1);
    renderBatchResult(csvText, elapsed);
    checkHealth();
    showToast('Batch processed! Download your results.','success');
  } catch(e) {
    clearInterval(fakeProgress);
    showToast(`Batch error: ${e.message}`,'error');
  } finally {
    setLoading('processBtn','batchSpinner',false);
  }
}

function animateProgress(fill, label) {
  let pct = 0;
  return setInterval(() => {
    pct = Math.min(pct + Math.random()*8, 88);
    fill.style.width  = `${pct}%`;
    label.textContent = `Processing… ${Math.round(pct)}%`;
  }, 400);
}

function renderBatchResult(csvText, elapsed) {
  const lines   = csvText.trim().split('\n');
  if (lines.length < 2) { showToast('Empty result.','error'); return; }
  const headers = parseCSVLine(lines[0]);
  const rows    = lines.slice(1).map(parseCSVLine);
  const si      = headers.findIndex(h=>h==='status');
  const replied   = rows.filter(r=>r[si]==='replied').length;
  const escalated = rows.filter(r=>r[si]==='escalated').length;
  _sessionTotal    += rows.length;
  _sessionReplied  += replied;
  _sessionEscalated += escalated;
  updateStats(_sessionTotal, _sessionReplied, _sessionEscalated, elapsed+'s');

  const displayCols = ['issue','company','status','product_area','request_type','justification'];
  const colIdxMap   = displayCols.map(c=>headers.findIndex(h=>h.trim().toLowerCase()===c));
  document.getElementById('tableHead').innerHTML = `<tr>${displayCols.map(c=>`<th>${c.replace(/_/g,' ')}</th>`).join('')}</tr>`;
  document.getElementById('tableBody').innerHTML = rows.map(row=>`
    <tr>${colIdxMap.map((ci,i)=>{
      const val = ci>=0?(row[ci]||'—'):'—';
      if(displayCols[i]==='status'){
        const cls=val==='replied'?'cell-replied':'cell-escalated';
        return `<td><span class="cell-badge ${cls}">${val}</span></td>`;
      }
      return `<td class="truncate" title="${escHtml(val)}">${escHtml(val.slice(0,80))}${val.length>80?'…':''}</td>`;
    }).join('')}</tr>`).join('');
  document.getElementById('batchResultCard').classList.remove('hidden');
  document.getElementById('batchResultCard').scrollIntoView({behavior:'smooth',block:'start'});
}

function downloadResult() {
  if (!_batchCsvBlob) return;
  const url = URL.createObjectURL(_batchCsvBlob);
  const a   = document.createElement('a');
  a.href    = url;
  a.download = `triage_result_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── History Tab ───────────────────────────────────────────────────────────────
async function loadHistory() {
  const company = document.getElementById('historyCompanyFilter').value;
  document.getElementById('historyLoading').style.display = 'block';
  document.getElementById('historyTable').style.display   = 'none';
  document.getElementById('historyEmpty').classList.add('hidden');
  try {
    const url = `${API_BASE}/history?limit=100${company?'&company='+encodeURIComponent(company):''}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.records.length) {
      document.getElementById('historyLoading').style.display = 'none';
      document.getElementById('historyEmpty').classList.remove('hidden');
      return;
    }
    renderHistoryTable(data.records);
    document.getElementById('historyLoading').style.display = 'none';
    document.getElementById('historyTable').style.display   = 'table';
  } catch(e) {
    document.getElementById('historyLoading').textContent = 'Failed to load history.';
  }
}

function renderHistoryTable(records) {
  document.getElementById('historyBody').innerHTML = records.map(r => {
    const badgeCls = r.status === 'replied' ? 'cell-replied' : 'cell-escalated';
    const srcColor = r.source === 'batch' ? 'color:var(--amber)' : 'color:var(--accent-light)';
    const time     = r.timestamp.replace('T',' ').replace('Z','');
    const issueTxt = (r.issue||'').slice(0,60) + ((r.issue||'').length>60?'…':'');
    return `<tr>
      <td style="color:var(--text-muted);font-family:var(--mono)">${r.id}</td>
      <td style="white-space:nowrap;font-size:11px;color:var(--text-muted)">${time}</td>
      <td>${escHtml(r.company||'—')}</td>
      <td class="truncate" title="${escHtml(r.issue)}">${escHtml(issueTxt)}</td>
      <td><span class="cell-badge ${badgeCls}">${r.status}</span></td>
      <td style="color:var(--text-secondary)">${(r.request_type||'').replace(/_/g,' ')}</td>
      <td style="${srcColor};font-size:11px">${r.source||'api'}</td>
    </tr>`;
  }).join('');
}

// ── Analytics Tab ─────────────────────────────────────────────────────────────
async function loadAnalytics() {
  try {
    const res  = await fetch(`${API_BASE}/analytics`);
    const data = await res.json();
    renderKPIs(data);
    renderCharts(data);
    renderEscalationTable(data.escalation_by_company || []);
    loadLowRated();   // load feedback low-rated table
  } catch(e) {
    showToast('Failed to load analytics.','error');
  }
}

async function loadLowRated() {
  try {
    const res  = await fetch(`${API_BASE}/feedback/summary`);
    const data = await res.json();
    const card = document.getElementById('lowRatedCard');
    const body = document.getElementById('lowRatedBody');
    if (!data.low_rated || data.low_rated.length === 0) {
      if (card) card.style.display = 'none';
      return;
    }
    if (card) card.style.display = '';
    body.innerHTML = data.low_rated.map(r => `
      <tr>
        <td><code>${r.id}</code></td>
        <td>${escHtml(r.company)}</td>
        <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${escHtml(r.issue)}">${escHtml(r.issue.substring(0,60))}${r.issue.length>60?'…':''}</td>
        <td><span class="badge badge-${r.status}" style="font-size:10px">${r.status.toUpperCase()}</span></td>
        <td style="color:var(--text-muted);font-size:12px">${escHtml(r.comment || '—')}</td>
        <td style="color:var(--text-muted);font-size:11px">${r.timestamp?.substring(0,10)||'—'}</td>
      </tr>`).join('');
  } catch(e) { /* silently skip if no feedback yet */ }
}


function renderKPIs(data) {
  const replied   = data.status_counts?.replied   || 0;
  const escalated = data.status_counts?.escalated || 0;
  const total     = data.total || 0;
  const rate      = total ? Math.round(escalated/total*100) : 0;
  document.getElementById('kpiTotal').textContent     = total.toLocaleString();
  document.getElementById('kpiReplied').textContent   = replied.toLocaleString();
  document.getElementById('kpiEscalated').textContent = escalated.toLocaleString();
  document.getElementById('kpiRate').textContent      = rate + '%';
  // Approval rate from feedback
  const fb  = data.feedback || {};
  const apr = fb.approval_rate != null ? fb.approval_rate + '%' : '—';
  const approvalEl = document.getElementById('kpiApproval');
  if (approvalEl) approvalEl.textContent = apr;
}

const CHART_COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316'];

function renderCharts(data) {
  const gridCfg = { color:'rgba(255,255,255,0.05)' };

  // 1. Status Donut
  const statusLabels = Object.keys(data.status_counts||{});
  const statusVals   = Object.values(data.status_counts||{});
  destroyChart('_chartStatus');
  _chartStatus = new Chart(document.getElementById('chartStatus'), {
    type: 'doughnut',
    data: {
      labels: statusLabels,
      datasets: [{ data: statusVals, backgroundColor: ['#10b981','#f59e0b','#ef4444'], borderWidth:0, hoverOffset:6 }],
    },
    options: { plugins:{ legend:{position:'bottom'} }, cutout:'65%', maintainAspectRatio:false },
  });

  // 2. Company Bar
  const compLabels = Object.keys(data.company_counts||{});
  const compVals   = Object.values(data.company_counts||{});
  destroyChart('_chartCompany');
  _chartCompany = new Chart(document.getElementById('chartCompany'), {
    type: 'bar',
    data: {
      labels: compLabels,
      datasets: [{ label:'Tickets', data:compVals, backgroundColor:CHART_COLORS, borderRadius:6, borderWidth:0 }],
    },
    options: { plugins:{legend:{display:false}}, scales:{x:{grid:gridCfg},y:{grid:gridCfg,beginAtZero:true}}, maintainAspectRatio:false },
  });

  // 3. Request Types Donut
  const typeLabels = Object.keys(data.request_type_counts||{});
  const typeVals   = Object.values(data.request_type_counts||{});
  destroyChart('_chartTypes');
  _chartTypes = new Chart(document.getElementById('chartTypes'), {
    type: 'doughnut',
    data: {
      labels: typeLabels,
      datasets: [{ data:typeVals, backgroundColor:CHART_COLORS, borderWidth:0, hoverOffset:6 }],
    },
    options: { plugins:{legend:{position:'bottom'}}, cutout:'65%', maintainAspectRatio:false },
  });

  // 4. Daily Volume Line
  const daily     = data.daily_volume || [];
  const dayLabels = daily.map(d=>d.day.slice(5));   // MM-DD
  const dayVals   = daily.map(d=>d.count);
  destroyChart('_chartDaily');
  _chartDaily = new Chart(document.getElementById('chartDaily'), {
    type: 'line',
    data: {
      labels: dayLabels,
      datasets: [{
        label:'Tickets',
        data: dayVals,
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99,102,241,0.12)',
        tension: 0.4,
        fill: true,
        pointRadius: 3,
        pointBackgroundColor: '#6366f1',
      }],
    },
    options: { plugins:{legend:{display:false}}, scales:{x:{grid:gridCfg},y:{grid:gridCfg,beginAtZero:true}}, maintainAspectRatio:false },
  });
}

function destroyChart(varName) {
  if (window[varName]) { window[varName].destroy(); window[varName] = null; }
}

function renderEscalationTable(rows) {
  document.getElementById('escalationBody').innerHTML = rows.map(r => `
    <tr>
      <td style="font-weight:500">${escHtml(r.company)}</td>
      <td>${r.total}</td>
      <td style="color:var(--amber)">${r.escalated}</td>
      <td style="color:${r.rate>50?'var(--red)':r.rate>25?'var(--amber)':'var(--green)'};font-weight:600">${r.rate}%</td>
      <td><div class="esc-bar-wrap"><div class="esc-bar-fill" style="width:${r.rate}%"></div></div></td>
    </tr>`).join('');
}

// ── Shared Stats Bar ──────────────────────────────────────────────────────────
function updateStats(total, replied, escalated, time='—') {
  document.getElementById('statsBar').style.display = 'grid';
  document.getElementById('statTotal').textContent     = total;
  document.getElementById('statReplied').textContent   = replied;
  document.getElementById('statEscalated').textContent = escalated;
  document.getElementById('statTime').textContent      = time;
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

function showToast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = `toast ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function formatBytes(b) {
  if (b<1024) return `${b} B`;
  if (b<1048576) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1048576).toFixed(1)} MB`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * Convert a subset of Markdown to safe HTML.
 * Handles: **bold**, *italic*, 1. lists, - bullets, *(Source:...)*, \n
 */
function md2html(text) {
  if (!text) return '';
  let s = escHtml(text);
  // **bold**
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // *italic* (not ** )
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // *(Source: ...)* → styled chip
  s = s.replace(/\*\(Source: (.+?)\)\*/g,
    '<div class="md-source">📄 <em>$1</em></div>');
  // **Additional context:** label
  s = s.replace(/\*\*Additional context:\*\*/g,
    '<div class="md-extra-label">Additional context</div>');
  // Numbered list items  1. text
  s = s.replace(/^(\d+)\.\s+(.+)$/gm,
    '<div class="md-list-item"><span class="md-num">$1.</span> $2</div>');
  // Bullet items  - text  or  * text
  s = s.replace(/^[-*]\s+(.+)$/gm,
    '<div class="md-list-item"><span class="md-bullet">•</span> $1</div>');
  // Paragraph breaks
  s = s.replace(/\n\n/g, '<br><br>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

function parseCSVLine(line) {
  const result=[]; let current=''; let inQuotes=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){ if(inQuotes&&line[i+1]==='"'){current+='"';i++;}else inQuotes=!inQuotes; }
    else if(ch===','&&!inQuotes){ result.push(current); current=''; }
    else current+=ch;
  }
  result.push(current);
  return result;
}

// ── Corpus Management Tab ─────────────────────────────────────────────────────

let _corpusZipFile = null;

// Company emoji map for visual variety
const COMPANY_EMOJI = {
  hackerrank: '💻', claude: '🤖', visa: '💳',
  shopify: '🛍️', stripe: '💳', notion: '📝', slack: '💬',
  github: '🐙', linear: '📊', intercom: '💬',
};
function companyEmoji(slug) {
  return COMPANY_EMOJI[slug.toLowerCase()] || '🏢';
}

async function loadCorpus() {
  const grid    = document.getElementById('corpusGrid');
  const loading = document.getElementById('corpusLoading');
  loading.style.display = 'block';
  grid.innerHTML = '';
  try {
    const res  = await fetch(`${API_BASE}/corpus/companies`);
    const data = await res.json();
    loading.style.display = 'none';
    renderCorpusGrid(data.companies || []);
  } catch(e) {
    loading.textContent = 'Failed to load corpus data.';
  }
}

function renderCorpusGrid(companies) {
  const grid = document.getElementById('corpusGrid');
  if (!companies.length) {
    grid.innerHTML = '<p style="color:var(--text-muted);padding:16px 0">No companies registered yet.</p>';
    return;
  }
  grid.innerHTML = companies.map(c => `
    <div class="corpus-card" id="card-${c.slug}">
      <div class="corpus-card-top">
        <div class="corpus-card-icon">${companyEmoji(c.slug)}</div>
        <span class="${c.is_default ? 'corpus-badge-default' : 'corpus-badge-custom'}">${c.is_default ? 'built-in' : 'custom'}</span>
      </div>
      <div class="corpus-card-name">${escHtml(c.display_name)}</div>
      <div class="corpus-card-slug">${escHtml(c.slug)}</div>
      <div class="corpus-card-docs">
        <span>${c.doc_count.toLocaleString()}</span>
        documents indexed
      </div>
      ${!c.is_default ? `<button class="corpus-card-del" onclick="deleteCompany('${c.slug}')">🗑 Remove</button>` : ''}
    </div>`).join('');
}

async function deleteCompany(slug) {
  if (!confirm(`Remove corpus for "${slug}"?\nThis will delete all uploaded docs. The index will need to be rebuilt.`)) return;
  try {
    const res  = await fetch(`${API_BASE}/corpus/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Delete failed');
    showToast(`Deleted "${slug}". Now rebuild the index.`, 'success');
    loadCorpus();
    setRebuildPending();
  } catch(e) {
    showToast(`Error: ${e.message}`, 'error');
  }
}

// ── ZIP Drop Zone ─────────────────────────────────────────────────────────────

function corpusDragOver(e) {
  e.preventDefault();
  document.getElementById('corpusDropZone').classList.add('dragging');
}
function corpusDragLeave() {
  document.getElementById('corpusDropZone').classList.remove('dragging');
}
function corpusDrop(e) {
  e.preventDefault();
  document.getElementById('corpusDropZone').classList.remove('dragging');
  const f = e.dataTransfer.files?.[0];
  if (f) applyCorpusFile(f);
}
function corpusFileSelect(e) {
  const f = e.target.files?.[0];
  if (f) applyCorpusFile(f);
}
function applyCorpusFile(file) {
  if (!file.name.endsWith('.zip')) { showToast('Please select a .zip file.', 'error'); return; }
  _corpusZipFile = file;
  document.getElementById('corpusDropText').textContent = file.name;
  document.getElementById('corpusDropSub').textContent  = formatBytes(file.size) + ' · Click to change';
  document.getElementById('corpusDropIcon').innerHTML   =
    `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
}

// ── Upload & Rebuild ──────────────────────────────────────────────────────────

async function uploadCorpus() {
  const name = document.getElementById('corpusCompanyName').value.trim();
  if (!name)           { showToast('Please enter a company name.', 'error'); return; }
  if (!_corpusZipFile) { showToast('Please select a ZIP file.', 'error'); return; }

  setLoading('corpusUploadBtn', 'corpusSpinner', true);
  try {
    const fd = new FormData();
    fd.append('company_name', name);
    fd.append('file', _corpusZipFile);

    const res  = await fetch(`${API_BASE}/corpus/upload`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Upload failed');

    showToast(`✅ "${data.slug}" — ${data.doc_count} docs extracted! Now rebuild the index.`, 'success');
    loadCorpus();
    setRebuildPending();

    // Reset form
    document.getElementById('corpusCompanyName').value = '';
    _corpusZipFile = null;
    document.getElementById('corpusDropText').textContent = 'Drag & drop ZIP here';
    document.getElementById('corpusDropSub').textContent  = 'or click to browse · max 50 MB';
    document.getElementById('corpusDropIcon').innerHTML   =
      `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
  } catch(e) {
    showToast(`Upload error: ${e.message}`, 'error');
  } finally {
    setLoading('corpusUploadBtn', 'corpusSpinner', false);
  }
}

async function rebuildIndex() {
  setLoading('rebuildBtn', 'rebuildSpinner', true);
  document.getElementById('rebuildStatus').textContent = '⚙️ Rebuilding index…';
  document.getElementById('rebuildSub').textContent    = 'This takes 2–10 seconds depending on corpus size.';
  try {
    const res  = await fetch(`${API_BASE}/corpus/rebuild`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Rebuild failed');
    document.getElementById('rebuildStatus').textContent = `✅ Index ready — ${data.chunks_indexed.toLocaleString()} chunks`;
    document.getElementById('rebuildSub').textContent    = `${data.company_count} companies: ${data.companies.join(', ')}`;
    showToast(`Index rebuilt! ${data.chunks_indexed.toLocaleString()} chunks from ${data.company_count} companies.`, 'success');
    loadCorpus();
    checkHealth();
  } catch(e) {
    document.getElementById('rebuildStatus').textContent = '❌ Rebuild failed';
    showToast(`Rebuild error: ${e.message}`, 'error');
  } finally {
    setLoading('rebuildBtn', 'rebuildSpinner', false);
  }
}

function setRebuildPending() {
  document.getElementById('rebuildStatus').textContent = '⚠️ Index rebuild required';
  document.getElementById('rebuildSub').textContent    = 'New docs uploaded. Click Rebuild to activate them.';
  document.getElementById('rebuildStatus').style.color = 'var(--amber)';
}

// ── Feedback (👍/👎) ──────────────────────────────────────────────────────────

let _lastTicketId   = 0;
let _pendingRating  = 0;   // -1 or +1, waiting for optional comment

function resetFeedbackUI() {
  const sec = document.getElementById('feedbackSection');
  if (!sec) return;
  document.getElementById('feedbackBtns').classList.remove('hidden');
  document.getElementById('feedbackCommentWrap').classList.add('hidden');
  document.getElementById('feedbackSent').classList.add('hidden');
  document.getElementById('feedbackComment').value = '';
  document.getElementById('fbUp').classList.remove('selected');
  document.getElementById('fbDn').classList.remove('selected');
  _pendingRating = 0;
}

async function submitFeedback(rating) {
  if (!_lastTicketId) { showToast('No ticket to rate yet.', 'error'); return; }

  _pendingRating = rating;

  // Visually select the button immediately
  document.getElementById('fbUp').classList.toggle('selected', rating === 1);
  document.getElementById('fbDn').classList.toggle('selected', rating === -1);

  if (rating === -1) {
    // Show comment box for negative feedback
    document.getElementById('feedbackCommentWrap').classList.remove('hidden');
    document.getElementById('feedbackComment').focus();
  } else {
    // Positive — send immediately
    await _sendFeedback(rating, '');
  }
}

async function sendFeedbackComment() {
  const comment = document.getElementById('feedbackComment').value.trim();
  await _sendFeedback(_pendingRating, comment);
}

async function _sendFeedback(rating, comment) {
  try {
    const res = await fetch(`${API_BASE}/feedback`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ticket_id: _lastTicketId, rating, comment }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Feedback failed');

    // Show thank-you message
    document.getElementById('feedbackBtns').classList.add('hidden');
    document.getElementById('feedbackCommentWrap').classList.add('hidden');
    document.getElementById('feedbackSent').classList.remove('hidden');

    const emoji = rating === 1 ? '👍' : '👎';
    showToast(`${emoji} Feedback recorded. Thanks!`, 'success');
  } catch(e) {
    showToast(`Feedback error: ${e.message}`, 'error');
  }
}

// Hook into submitSingle to capture ticket_id and reset feedback UI
const _origRenderSingleResult = window.renderSingleResult;
