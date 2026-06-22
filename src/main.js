const { invoke } = window.__TAURI__.core;

// ─── State ────────────────────────────────────────────────────────────────────
let tasks = [], projects = [], allBoards = [], allFolders = {};
let filter = 'all', folderFilter = 'all';
let priority = 'medium';
let editId = null, sessionToken = null;
let calYear = new Date().getFullYear(), calMonth = new Date().getMonth(), calSelected = null;
let currentView = 'tasks';       // 'tasks'|'calendar'|'project-overview'|'folder-tasks'|'board-view'
let currentProjectId = null;
let currentFolderId = null;
let currentBoardId = null;
let taskViewMode = 'flat';
let selectedTaskId = null;
let editingProjectId = null, projectColor = '#7c6af7';
let expandedProjects = new Set();
let modalDefaultProjectId = null, modalDefaultFolderId = null, modalDefaultColumnId = null;
let colColor = '#6b7280', editingColId = null;

const PROJECT_COLORS = ['#7c6af7','#60a5fa','#4ade80','#fbbf24','#f87171','#f472b6','#fb923c','#2dd4bf'];
const PRIORITY_COLORS = { high: '#f87171', medium: '#fbbf24', low: '#4ade80' };

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ─── Custom confirm dialog ────────────────────────────────────────────────────
let _confirmResolve = null;
function showConfirm(message, { title = 'Are you sure?', okLabel = 'Delete', variant = 'danger' } = {}) {
  return new Promise(resolve => {
    _confirmResolve = resolve;
    const ov = $('confirm-overlay');
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-ok').textContent = okLabel;
    $('confirm-ok').className = variant === 'warn' ? 'btn-secondary' : 'btn-danger';
    const wrap = $('confirm-icon-wrap');
    wrap.className = 'confirm-icon-wrap' + (variant === 'warn' ? ' warn' : '');
    $('confirm-icon-danger').classList.toggle('hidden', variant === 'warn');
    $('confirm-icon-warn').classList.toggle('hidden', variant !== 'warn');
    ov.classList.remove('hidden');
    $('confirm-ok').focus();
  });
}
function _closeConfirm(result) {
  $('confirm-overlay').classList.add('hidden');
  if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' ' +
         d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
}
function fmtCreated(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60)  return 'just now';
  if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  if (diff < 604800)return `${Math.floor(diff/86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function notifyLabel(m) {
  if (m >= 10080) return '1 week before';
  if (m >= 1440)  return `${Math.round(m/1440)} day(s) before`;
  if (m >= 60)    return `${Math.round(m/60)} hr(s) before`;
  return `${m} min before`;
}
function dueMeta(iso) {
  if (!iso) return null;
  const diff = new Date(iso) - new Date();
  const m = diff / 60000;
  if (m < 0)    return { html:'⚠ '+fmtDateTime(iso), cls:'overdue' };
  if (m < 60)   return { html:'⏰ '+fmtDateTime(iso), cls:'today' };
  if (m < 1440) return { html:'🕐 '+fmtDateTime(iso), cls:'soon' };
  return { html:'📅 '+fmtDateTime(iso), cls:'normal' };
}
function renderMd(t) {
  if (!t) return '';
  return esc(t)
    .replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/`([^`]+)`/g,'<code>$1</code>').replace(/^---$/gm,'<hr>')
    .replace(/^\> (.+)$/gm,'<blockquote>$1</blockquote>')
    .replace(/^\* (.+)$/gm,'<li>$1</li>').replace(/^\d+\. (.+)$/gm,'<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g,'<ul>$1</ul>').replace(/\n(?!<)/g,'<br>');
}
function stripMd(t) { return (t||'').replace(/[#*`_\[\]]/g,'').substring(0,80); }

// ─── Auth ─────────────────────────────────────────────────────────────────────
function saveToken(t,r) { r ? localStorage.setItem('tm_token',t) : sessionStorage.setItem('tm_token',t); if(!r) localStorage.removeItem('tm_token'); if(r) sessionStorage.removeItem('tm_token'); }
function loadToken() { return localStorage.getItem('tm_token') || sessionStorage.getItem('tm_token'); }
function clearToken() { localStorage.removeItem('tm_token'); sessionStorage.removeItem('tm_token'); }

async function initAuth() {
  const tok = loadToken();
  if (tok) {
    try { const u = await invoke('check_session',{token:tok}); sessionToken=tok; showApp(u); return; } catch(_) { clearToken(); }
  }
  $('screen-login').classList.remove('hidden'); $('screen-app').classList.add('hidden');
}
function showApp(user) {
  $('screen-login').classList.add('hidden'); $('screen-app').classList.remove('hidden');
  $('user-label').textContent = user.email;
  $('user-avatar').textContent = user.email.charAt(0).toUpperCase();
  loadAll();
}
async function loadAll() {
  [tasks, projects] = await Promise.all([invoke('get_tasks'), invoke('get_projects')]);
  if (projects.length) {
    const [boardsArr, foldersArr] = await Promise.all([
      Promise.all(projects.map(p => invoke('get_boards', { projectId: p.id }))),
      Promise.all(projects.map(p => invoke('get_folders', { projectId: p.id }))),
    ]);
    allBoards = boardsArr.flat();
    allFolders = {};
    for (let i = 0; i < projects.length; i++) allFolders[projects[i].id] = foldersArr[i];
  } else {
    allBoards = []; allFolders = {};
  }
  renderSidebarProjects(); populateProjectSelector(); renderCurrentView();
}

// ─── Navigation ──────────────────────────────────────────────────────────────
const ALL_VIEW_IDS = ['view-tasks','view-calendar','view-project-overview','view-folder-tasks','view-board'];
const VIEW_ID_MAP = {
  'tasks':            'view-tasks',
  'calendar':         'view-calendar',
  'project-overview': 'view-project-overview',
  'folder-tasks':     'view-folder-tasks',
  'board-view':       'view-board',
};

async function navigate(view, pid, fid, bid) {
  currentView = view;
  if (pid != null) currentProjectId = pid;
  if (fid != null) currentFolderId = fid;
  if (bid != null) currentBoardId = bid;
  selectedTaskId = null; closeDetailPanel();
  document.querySelectorAll('.nav-item').forEach(i =>
    i.classList.toggle('active', i.dataset.view === view && pid == null)
  );
  ALL_VIEW_IDS.forEach(id => { const e = $(id); if (e) e.classList.add('hidden'); });
  const target = VIEW_ID_MAP[view] ? $(VIEW_ID_MAP[view]) : null;
  if (target) target.classList.remove('hidden');
  renderSidebarProjects();
  await renderCurrentView();
}

async function renderCurrentView() {
  if (currentView === 'tasks')            { renderTasks(); renderStats(); }
  else if (currentView === 'calendar')    renderCalendar();
  else if (currentView === 'project-overview' && currentProjectId) renderProjectOverview(currentProjectId);
  else if (currentView === 'folder-tasks' && currentFolderId)      renderFolderView(currentFolderId);
  else if (currentView === 'board-view'   && currentBoardId)       await renderBoardView(currentBoardId);
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function renderSidebarProjects() {
  const el = $('sidebar-project-list');
  if (!projects.length) {
    el.innerHTML = '<div style="padding:6px 10px;font-size:12px;color:var(--text2)">No projects yet</div>';
    return;
  }
  if (currentProjectId) expandedProjects.add(currentProjectId);

  el.innerHTML = projects.map(p => {
    const taskCount = tasks.filter(t => t.project_id === p.id).length;
    const projBoards = allBoards.filter(b => b.project_id === p.id);
    const projFolders = (allFolders[p.id] || []).filter(f => !f.parent_id);
    const isExpanded = expandedProjects.has(p.id);
    const isProjActive = currentProjectId === p.id && currentView === 'project-overview';

    const innerHtml = isExpanded ? buildProjInner(p.id, projFolders, projBoards) : '';

    return `<div class="sidebar-project-group">
      <div class="project-nav-row${isProjActive ? ' active' : ''}">
        <button class="project-nav-chevron${isExpanded ? ' expanded' : ''}" data-pid="${p.id}">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="project-nav-item" data-pid="${p.id}">
          <span class="project-nav-dot" style="background:${p.color}"></span>
          <span class="project-nav-name">${esc(p.name)}</span>
          ${taskCount ? `<span class="project-nav-count">${taskCount}</span>` : ''}
        </button>
      </div>
      ${innerHtml}
    </div>`;
  }).join('');

  el.querySelectorAll('.project-nav-item').forEach(b => b.addEventListener('click', () => {
    const pid = Number(b.dataset.pid);
    expandedProjects.add(pid);
    navigate('project-overview', pid);
  }));
  el.querySelectorAll('.project-nav-chevron').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const pid = Number(btn.dataset.pid);
    if (expandedProjects.has(pid)) expandedProjects.delete(pid); else expandedProjects.add(pid);
    renderSidebarProjects();
  }));
  el.querySelectorAll('.folder-nav-item').forEach(btn => btn.addEventListener('click', () => {
    navigate('folder-tasks', Number(btn.dataset.pid), Number(btn.dataset.fid));
  }));
  el.querySelectorAll('.folder-nav-chevron').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    btn.classList.toggle('expanded');
    const children = btn.closest('.folder-nav-group').querySelector('.folder-nav-children');
    if (children) children.classList.toggle('hidden');
  }));
  el.querySelectorAll('.board-nav-item').forEach(btn => btn.addEventListener('click', () => {
    navigate('board-view', Number(btn.dataset.pid), null, Number(btn.dataset.bid));
  }));
  el.querySelectorAll('.btn-add-folder-sidebar').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const pid = Number(btn.dataset.pid);
    const name = prompt('Folder name:'); if (!name) return;
    const f = await invoke('create_folder', { projectId: pid, parentId: null, name });
    if (!allFolders[pid]) allFolders[pid] = [];
    allFolders[pid].push(f);
    renderSidebarProjects();
  }));
  el.querySelectorAll('.btn-add-board-sidebar').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const pid = Number(btn.dataset.pid);
    const name = prompt('Board name:', 'My Board'); if (!name) return;
    const b = await invoke('create_board', { projectId: pid, name });
    allBoards.push(b);
    navigate('board-view', pid, null, b.id);
  }));
}

function buildProjInner(pid, rootFolders, projBoards) {
  const allF = allFolders[pid] || [];
  const folderHtml = rootFolders.length ? `
    <div class="proj-nav-section">
      <div class="proj-nav-section-label">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        Folders
        <button class="btn-add-folder-sidebar" data-pid="${pid}" title="Add folder">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
      ${renderSidebarFolderNodes(allF, rootFolders, pid, 0)}
    </div>` : `
    <div class="proj-nav-section">
      <button class="proj-nav-add-item btn-add-folder-sidebar" data-pid="${pid}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Folder
      </button>
    </div>`;

  const boardHtml = projBoards.length ? `
    <div class="proj-nav-section">
      <div class="proj-nav-section-label">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="5" height="8" rx="1"/></svg>
        Boards
        <button class="btn-add-board-sidebar" data-pid="${pid}" title="Add board">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
      ${projBoards.map(b => `
        <button class="board-nav-item${currentBoardId === b.id && currentView === 'board-view' ? ' active' : ''}" data-pid="${pid}" data-bid="${b.id}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="5" height="8" rx="1"/></svg>
          <span class="board-nav-name">${esc(b.name)}</span>
          <span class="board-nav-col-count">${b.columns ? b.columns.length : 0}</span>
        </button>`).join('')}
    </div>` : `
    <div class="proj-nav-section">
      <button class="proj-nav-add-item btn-add-board-sidebar" data-pid="${pid}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Board
      </button>
    </div>`;

  return `<div class="proj-nav-inner">${folderHtml}${boardHtml}</div>`;
}

function renderSidebarFolderNodes(allF, list, pid, depth) {
  return list.map(f => {
    const children = allF.filter(x => x.parent_id === f.id);
    const fTaskCount = tasks.filter(t => t.folder_id === f.id).length;
    const isActive = currentFolderId === f.id && currentView === 'folder-tasks';
    return `<div class="folder-nav-group">
      <div class="folder-nav-row${isActive ? ' active' : ''}" style="padding-left:${depth * 10}px">
        ${children.length
          ? `<button class="folder-nav-chevron" data-fid="${f.id}"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button>`
          : '<span class="folder-nav-spacer"></span>'}
        <button class="folder-nav-item" data-pid="${pid}" data-fid="${f.id}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span class="folder-nav-name">${esc(f.name)}</span>
          ${fTaskCount ? `<span class="folder-nav-count">${fTaskCount}</span>` : ''}
        </button>
      </div>
      ${children.length ? `<div class="folder-nav-children hidden">${renderSidebarFolderNodes(allF, children, pid, depth + 1)}</div>` : ''}
    </div>`;
  }).join('');
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function renderStats() {
  const total=tasks.length, done=tasks.filter(t=>t.completed).length, active=total-done;
  const overdue=tasks.filter(t=>!t.completed&&t.due_date&&new Date(t.due_date)<new Date()).length;
  $('task-stats').innerHTML = `
    <div class="stat-item"><span class="stat-num accent">${total}</span><span class="stat-label">Total</span></div>
    <div class="stat-sep"></div>
    <div class="stat-item"><span class="stat-num">${active}</span><span class="stat-label">Active</span></div>
    <div class="stat-sep"></div>
    <div class="stat-item"><span class="stat-num success">${done}</span><span class="stat-label">Done</span></div>
    ${overdue?`<div class="stat-sep"></div><div class="stat-item"><span class="stat-num danger">${overdue}</span><span class="stat-label">Overdue</span></div>`:''}`;
}

// ─── Task list helpers ────────────────────────────────────────────────────────
function applyFilter(taskArr, f) {
  if (f === 'active') return taskArr.filter(t => !t.completed);
  if (f === 'completed') return taskArr.filter(t => t.completed);
  return taskArr;
}

function taskCardHTML(t, showProject) {
  const proj = t.project_id ? projects.find(p => p.id === t.project_id) : null;
  const folder = t.folder_id ? (Object.values(allFolders).flat()).find(f => f.id === t.folder_id) : null;
  const priColor = t.priority === 'high' ? '#f87171' : t.priority === 'medium' ? '#fbbf24' : '#4ade80';
  return `<div class="task-card${t.completed ? ' done' : ''}" data-id="${t.id}" style="--pri-color:${priColor}${proj ? ';--proj-color:' + proj.color : ''}">
    <span class="task-check${t.completed ? ' checked' : ''}" data-check="${t.id}"></span>
    <div class="task-body">
      <div class="task-title">${esc(t.title)}</div>
      <div class="task-meta">
        ${t.due_date ? `<span class="task-due${!t.completed && new Date(t.due_date) < new Date() ? ' overdue' : ''}">${fmtDateTime(t.due_date)}</span>` : ''}
        <span class="badge ${t.priority}">${t.priority}</span>
        ${proj && showProject ? `<span class="task-proj-tag" style="background:color-mix(in srgb,${proj.color} 18%,transparent);color:${proj.color}">${esc(proj.name)}</span>` : ''}
        ${folder ? `<span class="task-folder-tag">${esc(folder.name)}</span>` : ''}
      </div>
    </div>
  </div>`;
}

function attachCardListeners(container) {
  container.querySelectorAll('.task-check').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation();
      const id = Number(el.dataset.check);
      const done = await invoke('toggle_task', { id });
      const t = tasks.find(x => x.id === id);
      if (t) { t.completed = done; renderCurrentView(); }
    });
  });
  container.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.task-check')) return;
      const t = tasks.find(x => x.id === Number(card.dataset.id));
      if (t) { selectedTaskId = t.id; openDetailPanel(t); }
    });
  });
}

function renderTasks() {
  const filtered = applyFilter(tasks, filter);
  const list = $('task-list');
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state"><p>No tasks yet. Click "New Task" to get started.</p></div>';
    return;
  }
  if (taskViewMode === 'grouped') {
    const grouped = {};
    filtered.forEach(t => {
      const key = t.project_id || '__none__';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(t);
    });
    let html = '';
    if (grouped['__none__']) {
      html += `<div class="task-group"><div class="task-group-hdr">No Project</div>
        ${grouped['__none__'].map(t => taskCardHTML(t, false)).join('')}</div>`;
    }
    projects.forEach(p => {
      if (grouped[p.id]) {
        html += `<div class="task-group">
          <div class="task-group-hdr" style="color:${p.color}">
            <span class="task-group-dot" style="background:${p.color}"></span>${esc(p.name)}
          </div>
          ${grouped[p.id].map(t => taskCardHTML(t, false)).join('')}
        </div>`;
      }
    });
    list.innerHTML = html;
  } else {
    list.innerHTML = filtered.map(t => taskCardHTML(t, true)).join('');
  }
  attachCardListeners(list);
}

// ─── Project Overview ─────────────────────────────────────────────────────────
function renderProjectOverview(pid) {
  const proj = projects.find(p => p.id === pid); if (!proj) return;
  const projTasks = tasks.filter(t => t.project_id === pid);
  const done = projTasks.filter(t => t.completed).length;
  const active = projTasks.filter(t => !t.completed).length;
  const overdue = projTasks.filter(t => !t.completed && t.due_date && new Date(t.due_date) < new Date()).length;
  const pct = projTasks.length ? Math.round(done / projTasks.length * 100) : 0;
  const projFolders = allFolders[pid] || [];
  const projBoards = allBoards.filter(b => b.project_id === pid);

  $('proj-ov-content').innerHTML = `
    <div class="pov-header" style="--proj-color:${proj.color}">
      <div class="pov-header-body">
        <div class="pov-title">${esc(proj.name)}</div>
        ${proj.description ? `<div class="pov-desc">${esc(proj.description)}</div>` : ''}
        <div class="pov-progress-row">
          <div class="pov-progress-bar-wrap"><div class="pov-progress-fill" style="width:${pct}%;background:${proj.color}"></div></div>
          <span class="pov-pct">${pct}%</span>
        </div>
      </div>
      <div class="pov-header-actions">
        <button class="btn-secondary btn-sm" id="pov-edit-btn">Edit</button>
        <button class="btn-danger btn-sm" id="pov-del-btn">Delete</button>
      </div>
    </div>

    <div class="pov-stats">
      <div class="pov-stat-card accent" style="--proj-color:${proj.color}">
        <span class="pov-stat-num">${projTasks.length}</span>
        <span class="pov-stat-label">Total Tasks</span>
      </div>
      <div class="pov-stat-card">
        <span class="pov-stat-num" style="color:#4ade80">${done}</span>
        <span class="pov-stat-label">Completed</span>
      </div>
      <div class="pov-stat-card">
        <span class="pov-stat-num">${active}</span>
        <span class="pov-stat-label">Active</span>
      </div>
      <div class="pov-stat-card">
        <span class="pov-stat-num" style="color:${overdue ? '#f87171' : 'var(--text2)'}">${overdue}</span>
        <span class="pov-stat-label">Overdue</span>
      </div>
    </div>

    <div class="pov-grid">
      <div class="pov-card">
        <div class="pov-card-hdr">
          <div class="pov-card-title">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            Folders
          </div>
          <button class="btn-sm btn-secondary pov-add-folder-btn" data-pid="${pid}">+ Add</button>
        </div>
        <div class="pov-card-body" id="pov-folders-list">
          ${projFolders.filter(f => !f.parent_id).length
            ? projFolders.filter(f => !f.parent_id).map(f => {
                const fc = tasks.filter(t => t.folder_id === f.id).length;
                const sub = projFolders.filter(x => x.parent_id === f.id).length;
                return `<div class="pov-item pov-folder-item" data-pid="${pid}" data-fid="${f.id}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  <span class="pov-item-name">${esc(f.name)}</span>
                  <span class="pov-item-count">${fc} task${fc !== 1 ? 's' : ''}${sub ? ` · ${sub} sub` : ''}</span>
                </div>`;
              }).join('')
            : '<div class="pov-empty">No folders yet. Click "+ Add" to create one.</div>'}
        </div>
      </div>

      <div class="pov-card">
        <div class="pov-card-hdr">
          <div class="pov-card-title">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="5" height="8" rx="1"/></svg>
            Boards
          </div>
          <button class="btn-sm btn-secondary pov-add-board-btn" data-pid="${pid}">+ Add</button>
        </div>
        <div class="pov-card-body">
          ${projBoards.length
            ? projBoards.map(b => {
                const bc = tasks.filter(t => b.columns && b.columns.some(c => c.id === t.board_column_id)).length;
                return `<div class="pov-item pov-board-item" data-pid="${pid}" data-bid="${b.id}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="5" height="8" rx="1"/></svg>
                  <span class="pov-item-name">${esc(b.name)}</span>
                  <span class="pov-item-count">${b.columns ? b.columns.length : 0} col${b.columns && b.columns.length !== 1 ? 's' : ''}</span>
                </div>`;
              }).join('')
            : '<div class="pov-empty">No boards yet. Click "+ Add" to create one.</div>'}
        </div>
      </div>
    </div>`;

  $('pov-edit-btn').addEventListener('click', () => openProjectModal(pid));
  $('pov-del-btn').addEventListener('click', () => deleteProject(pid));
  $('proj-ov-content').querySelectorAll('.pov-folder-item').forEach(el =>
    el.addEventListener('click', () => navigate('folder-tasks', Number(el.dataset.pid), Number(el.dataset.fid)))
  );
  $('proj-ov-content').querySelectorAll('.pov-board-item').forEach(el =>
    el.addEventListener('click', () => navigate('board-view', Number(el.dataset.pid), null, Number(el.dataset.bid)))
  );
  $('proj-ov-content').querySelector('.pov-add-folder-btn').addEventListener('click', async () => {
    const name = prompt('Folder name:'); if (!name) return;
    const f = await invoke('create_folder', { projectId: pid, parentId: null, name });
    if (!allFolders[pid]) allFolders[pid] = [];
    allFolders[pid].push(f);
    renderSidebarProjects(); renderProjectOverview(pid);
  });
  $('proj-ov-content').querySelector('.pov-add-board-btn').addEventListener('click', async () => {
    const name = prompt('Board name:', 'My Board'); if (!name) return;
    const b = await invoke('create_board', { projectId: pid, name });
    allBoards.push(b);
    navigate('board-view', pid, null, b.id);
  });
}

// ─── Folder Tasks View ────────────────────────────────────────────────────────
function renderFolderView(fid) {
  const folder = (Object.values(allFolders).flat()).find(f => f.id === fid); if (!folder) return;
  const proj = projects.find(p => p.id === folder.project_id);
  const folderPath = getFolderPath(folder.project_id, fid);

  // Breadcrumb
  const breadcrumb = [
    proj ? `<span class="crumb" data-pid="${proj.id}">${esc(proj.name)}</span>` : '',
    ...folderPath.slice(0, -1).map(f => `<span class="crumb" data-fid="${f.id}" data-pid="${proj ? proj.id : ''}">${esc(f.name)}</span>`),
    `<span class="crumb-current">${esc(folder.name)}</span>`,
  ].filter(Boolean).join('<span class="crumb-sep">›</span>');

  $('folder-view-hdr').innerHTML = `
    <div class="sub-view-breadcrumb">${breadcrumb}</div>
    <div class="sub-view-hdr-actions">
      <button class="btn-icon-sm rename-folder-btn" data-fid="${fid}" title="Rename">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="btn-icon-sm add-subfolder-btn" data-fid="${fid}" data-pid="${folder.project_id}" title="Add subfolder">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>`;

  // Breadcrumb clicks
  $('folder-view-hdr').querySelectorAll('.crumb[data-pid]').forEach(el => {
    el.addEventListener('click', () => navigate('project-overview', Number(el.dataset.pid)));
  });
  $('folder-view-hdr').querySelectorAll('.crumb[data-fid]').forEach(el => {
    el.addEventListener('click', () => navigate('folder-tasks', Number(el.dataset.pid), Number(el.dataset.fid)));
  });
  $('folder-view-hdr').querySelector('.rename-folder-btn').addEventListener('click', async () => {
    const name = prompt('New name:', folder.name); if (!name || name === folder.name) return;
    const upd = await invoke('rename_folder', { id: fid, name });
    const pid = folder.project_id;
    if (allFolders[pid]) {
      const i = allFolders[pid].findIndex(f => f.id === fid);
      if (i !== -1) allFolders[pid][i] = upd;
    }
    renderSidebarProjects(); renderFolderView(fid);
  });
  $('folder-view-hdr').querySelector('.add-subfolder-btn').addEventListener('click', async () => {
    const name = prompt('Subfolder name:'); if (!name) return;
    const f = await invoke('create_folder', { projectId: folder.project_id, parentId: fid, name });
    if (!allFolders[folder.project_id]) allFolders[folder.project_id] = [];
    allFolders[folder.project_id].push(f);
    renderSidebarProjects();
    // Re-render current folder view to show subfolder
    renderFolderView(fid);
  });

  // Subfolders
  const subfolders = (allFolders[folder.project_id] || []).filter(f => f.parent_id === fid);

  const folderTaskList = applyFilter(tasks.filter(t => t.folder_id === fid), folderFilter);
  const list = $('folder-task-list');

  let html = '';
  if (subfolders.length) {
    html += `<div class="folder-subfolders-row">` +
      subfolders.map(sf => {
        const sfc = tasks.filter(t => t.folder_id === sf.id).length;
        return `<button class="subfolder-chip" data-pid="${folder.project_id}" data-fid="${sf.id}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          ${esc(sf.name)}<span style="opacity:.6;margin-left:4px">${sfc}</span>
        </button>`;
      }).join('') + '</div>';
  }

  if (!folderTaskList.length) {
    html += `<div class="empty-state"><p>No tasks in this folder yet.</p></div>`;
    list.innerHTML = html;
  } else {
    list.innerHTML = html + folderTaskList.map(t => taskCardHTML(t, false)).join('');
    attachCardListeners(list);
  }

  list.querySelectorAll('.subfolder-chip').forEach(btn => btn.addEventListener('click', () =>
    navigate('folder-tasks', Number(btn.dataset.pid), Number(btn.dataset.fid))
  ));
}

function getFolderPath(pid, fid) {
  const allF = allFolders[pid] || [];
  const path = [];
  let f = allF.find(x => x.id === fid);
  while (f) { path.unshift(f); f = f.parent_id ? allF.find(x => x.id === f.parent_id) : null; }
  return path;
}

// ─── Board view (full) ────────────────────────────────────────────────────────
async function renderBoardView(bid) {
  // Always reload fresh board data from server
  let board = allBoards.find(b => b.id === bid);
  const pid = board ? board.project_id : currentProjectId;
  if (!pid && !board) return;
  currentProjectId = pid;

  const freshBoards = await invoke('get_boards', { projectId: pid });
  allBoards = allBoards.filter(b => b.project_id !== pid).concat(freshBoards);
  const freshBoard = freshBoards.find(b => b.id === bid);
  if (!freshBoard) return;

  const proj = projects.find(p => p.id === pid);

  // Header
  $('board-view-hdr').innerHTML = `
    <div class="sub-view-breadcrumb">
      ${proj ? `<span class="crumb" data-pid="${pid}">${esc(proj.name)}</span><span class="crumb-sep">›</span>` : ''}
      <span class="crumb-current">${esc(freshBoard.name)}</span>
    </div>
    <div class="sub-view-hdr-actions">
      <button class="btn-ghost btn-sm" id="btn-rename-board">Rename</button>
      <button class="btn-danger btn-sm" id="btn-delete-board">Delete Board</button>
      <button class="btn-primary btn-sm" id="btn-add-col">+ Column</button>
    </div>`;

  $('board-view-hdr').querySelector('.crumb[data-pid]')?.addEventListener('click', e =>
    navigate('project-overview', Number(e.currentTarget.dataset.pid))
  );
  $('board-view-hdr').querySelector('#btn-rename-board').addEventListener('click', async () => {
    const name = prompt('New name:', freshBoard.name); if (!name || name === freshBoard.name) return;
    const upd = await invoke('rename_board', { id: bid, name });
    const i = allBoards.findIndex(b => b.id === bid); if (i !== -1) allBoards[i] = upd;
    renderSidebarProjects(); renderBoardView(bid);
  });
  $('board-view-hdr').querySelector('#btn-delete-board').addEventListener('click', async () => {
    if (!await showConfirm(`Delete "${freshBoard.name}"?`, { title: 'Delete Board', okLabel: 'Delete Board' })) return;
    await invoke('delete_board', { id: bid });
    allBoards = allBoards.filter(b => b.id !== bid);
    renderSidebarProjects();
    navigate('project-overview', pid);
  });
  $('board-view-hdr').querySelector('#btn-add-col').addEventListener('click', () => openColModal());

  // Render canvas
  const hasColumns = freshBoard.columns && freshBoard.columns.length > 0;
  $('board-canvas').classList.toggle('hidden', !hasColumns);
  $('board-empty').classList.toggle('hidden', hasColumns);

  if (hasColumns) {
    renderBoard(freshBoard);
  } else {
    $('btn-board-add-first-col').onclick = () => openColModal();
  }
}

function renderBoard(board) {
  const pid = currentProjectId;
  const boardColIds = new Set(board.columns.map(c => c.id));
  const projTasks = tasks.filter(t => t.project_id === pid);
  const firstColId = board.columns[0]?.id;

  const canvas = $('board-canvas');
  canvas.innerHTML = '';

  for (const col of board.columns) {
    const colTasks = projTasks.filter(t => {
      if (t.board_column_id === col.id) return true;
      if (col.id === firstColId && (!t.board_column_id || !boardColIds.has(t.board_column_id))) return true;
      return false;
    });
    const done = colTasks.filter(t => t.completed).length;

    const colEl = document.createElement('div');
    colEl.className = 'board-col';
    colEl.dataset.colId = col.id;
    colEl.style.setProperty('--col-color', col.color);
    colEl.innerHTML = `
      <div class="board-col-header">
        <div class="board-col-header-top">
          <span class="board-col-name">${esc(col.name)}</span>
          <div class="board-col-header-right">
            <span class="board-col-count">${colTasks.length}</span>
            <div class="board-col-actions">
              <button class="col-edit-btn" title="Edit column">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              ${board.columns.length > 1
                ? `<button class="col-del-btn" title="Delete column"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>`
                : ''}
            </div>
          </div>
        </div>
        ${colTasks.length > 0
          ? `<div class="board-col-progress">
               <div class="board-col-progress-bar" style="width:${Math.round(done/colTasks.length*100)}%;background:${col.color}"></div>
             </div>`
          : ''}
      </div>
      <div class="board-col-tasks"></div>
      <div class="board-col-add">
        <button class="board-col-add-btn">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Task
        </button>
      </div>`;

    const tasksContainer = colEl.querySelector('.board-col-tasks');
    for (const task of colTasks) {
      tasksContainer.appendChild(makeBoardCard(task));
    }

    // ── Drag and drop on the ENTIRE column ──
    colEl.addEventListener('dragenter', e => {
      e.preventDefault();
      colEl.classList.add('drag-over');
    });
    colEl.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    colEl.addEventListener('dragleave', e => {
      // only remove highlight when truly leaving the column (not entering a child)
      if (e.currentTarget === colEl && !colEl.contains(e.relatedTarget)) {
        colEl.classList.remove('drag-over');
      }
    });
    colEl.addEventListener('drop', async e => {
      e.preventDefault();
      colEl.classList.remove('drag-over');
      const taskId = Number(e.dataTransfer.getData('text/plain'));
      if (!taskId) return;
      // Optimistic update
      const i = tasks.findIndex(t => t.id === taskId);
      if (i !== -1) tasks[i] = { ...tasks[i], board_column_id: col.id };
      const currentBoard = allBoards.find(b => b.id === currentBoardId) || board;
      renderBoard(currentBoard);
      // Persist
      try {
        const updatedTask = await invoke('move_task_to_column', { taskId, columnId: col.id });
        const j = tasks.findIndex(t => t.id === taskId);
        if (j !== -1) tasks[j] = updatedTask;
        if (selectedTaskId === taskId) renderDetailPanel(updatedTask);
      } catch (err) {
        console.error('move failed', err);
        // revert: reload tasks
        tasks = await invoke('get_tasks');
        renderBoard(allBoards.find(b => b.id === currentBoardId) || board);
      }
    });

    colEl.querySelector('.board-col-add-btn').addEventListener('click', () => {
      modalDefaultColumnId = col.id; openModal(null);
    });
    colEl.querySelector('.col-edit-btn').addEventListener('click', () => {
      openColModal(col.id, col.name, col.color);
    });
    colEl.querySelector('.col-del-btn')?.addEventListener('click', async () => {
      if (!await showConfirm(`Delete column "${col.name}"? Tasks in this column will become unassigned.`, { title: 'Delete Column', okLabel: 'Delete Column' })) return;
      await invoke('delete_board_column', { id: col.id });
      tasks.forEach(t => { if (t.board_column_id === col.id) t.board_column_id = null; });
      allBoards = allBoards.filter(b => b.project_id !== currentProjectId).concat(
        await invoke('get_boards', { projectId: currentProjectId }));
      renderSidebarProjects(); await renderBoardView(currentBoardId);
    });

    canvas.appendChild(colEl);
  }
}

function makeBoardCard(task) {
  const due = dueMeta(task.due_date);
  const priColor = PRIORITY_COLORS[task.priority] || '#6b7280';
  const folder = task.folder_id ? (Object.values(allFolders).flat()).find(f => f.id === task.folder_id) : null;

  const div = document.createElement('div');
  div.className = `board-card${task.completed ? ' done' : ''}`;
  div.draggable = true;
  div.dataset.id = task.id;
  div.style.setProperty('--pri-color', priColor);

  div.innerHTML = `
    <div class="board-card-top">
      <span class="board-card-id">${task.task_id}</span>
      <button class="board-card-check${task.completed ? ' checked' : ''}" data-id="${task.id}" title="${task.completed ? 'Reopen' : 'Complete'}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
      </button>
    </div>
    <div class="board-card-title${task.completed ? ' done' : ''}">${esc(task.title)}</div>
    <div class="board-card-footer">
      <span class="board-card-pri" style="background:${priColor}20;color:${priColor}">${task.priority}</span>
      ${folder ? `<span class="board-card-folder"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>${esc(folder.name)}</span>` : ''}
      ${due ? `<span class="board-card-due ${due.cls}">${due.html}</span>` : ''}
    </div>`;

  div.querySelector('.board-card-check').addEventListener('click', async e => {
    e.stopPropagation();
    const done = await invoke('toggle_task', { id: task.id });
    const i = tasks.findIndex(t => t.id === task.id);
    if (i !== -1) tasks[i].completed = done;
    if (selectedTaskId === task.id) renderDetailPanel(tasks[i]);
    const currentBoard = allBoards.find(b => b.id === currentBoardId);
    if (currentBoard) renderBoard(currentBoard); else if (currentBoardId) await renderBoardView(currentBoardId);
    renderSidebarProjects();
  });

  div.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', String(task.id));
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => div.classList.add('dragging'));
  });
  div.addEventListener('dragend', () => div.classList.remove('dragging'));
  div.addEventListener('click', e => {
    if (e.target.closest('.board-card-check')) return;
    selectedTaskId = task.id;
    openDetailPanel(tasks.find(t => t.id === task.id) || task);
  });
  return div;
}

// ─── Column modal ─────────────────────────────────────────────────────────────
function openColModal(colId=null, name='', color='#6b7280') {
  editingColId=colId; colColor=color;
  $('col-modal-title').textContent=colId?'Edit Column':'New Column';
  $('btn-submit-col').textContent=colId?'Save':'Add Column';
  $('inp-col-name').value=name;
  $('col-form-error').classList.add('hidden');
  renderColColorSwatches();
  $('col-modal-overlay').classList.add('open');
  $('inp-col-name').focus();
}
function closeColModal() { $('col-modal-overlay').classList.remove('open'); editingColId=null; }
function renderColColorSwatches() {
  $('col-color-swatches').innerHTML=PROJECT_COLORS.map(c=>`<button type="button" class="color-swatch${c===colColor?' selected':''}" data-color="${c}" style="background:${c}"></button>`).join('');
  $('col-color-swatches').querySelectorAll('.color-swatch').forEach(b=>{
    b.addEventListener('click',()=>{ colColor=b.dataset.color; $('col-color-swatches').querySelectorAll('.color-swatch').forEach(x=>x.classList.toggle('selected',x.dataset.color===colColor)); });
  });
}

// ─── Task detail panel ────────────────────────────────────────────────────────
function openDetailPanel(task) { $('task-detail').classList.add('open'); renderDetailPanel(task); }
function closeDetailPanel() {
  $('task-detail').classList.remove('open'); selectedTaskId=null;
  document.querySelectorAll('.task-card.selected').forEach(c=>c.classList.remove('selected'));
}
function renderDetailPanel(task) {
  if(!task) return;
  const proj=task.project_id?projects.find(p=>p.id===task.project_id):null;
  const due=dueMeta(task.due_date);
  $('detail-body').innerHTML=`
    <div class="detail-badges">
      <span class="task-id-badge">${task.task_id}</span>
      <span class="badge ${task.priority}">${task.priority}</span>
      ${task.completed?'<span class="badge" style="background:#4ade8020;color:#4ade80">Done</span>':''}
    </div>
    <h1 class="detail-title${task.completed?' done':''}">${esc(task.title)}</h1>
    ${task.description?`<div class="detail-description">${renderMd(task.description)}</div>`:''}
    <div class="detail-meta">
      ${proj?`<div class="detail-meta-item"><span class="detail-meta-label">Project</span><span class="detail-meta-value" style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:${proj.color};display:inline-block"></span>${esc(proj.name)}</span></div>`:''}
      ${due?`<div class="detail-meta-item"><span class="detail-meta-label">Due</span><span class="detail-meta-value due-chip ${due.cls}">${due.html}</span></div>`:''}
      <div class="detail-meta-item"><span class="detail-meta-label">Notify</span><span class="detail-meta-value">${notifyLabel(task.notify_before_minutes)}</span></div>
      <div class="detail-meta-item"><span class="detail-meta-label">Created</span><span class="detail-meta-value">${fmtCreated(task.created_at)}</span></div>
    </div>
    <button class="btn-toggle-complete${task.completed?' completed':''}" data-id="${task.id}">
      ${task.completed
        ?'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg> Mark Incomplete'
        :'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Mark Complete'}
    </button>
    <div class="history-section">
      <div class="history-title">History</div>
      <div class="history-list" id="history-list"><span style="font-size:12px;color:var(--text2)">Loading…</span></div>
    </div>`;

  $('detail-body').querySelector('.btn-toggle-complete').addEventListener('click', async e=>{
    const id=Number(e.currentTarget.dataset.id);
    const done=await invoke('toggle_task',{id});
    const t=tasks.find(t=>t.id===id); if(t) t.completed=done;
    renderDetailPanel(tasks.find(t=>t.id===id)); renderCurrentView(); renderSidebarProjects();
  });
  $('btn-edit-detail').onclick=()=>openModal(task);
  $('btn-delete-detail').onclick=async()=>{
    if(!await showConfirm('This task will be permanently deleted.', { title: 'Delete Task', okLabel: 'Delete Task' })) return;
    await invoke('delete_task',{id:task.id}); tasks=tasks.filter(t=>t.id!==task.id);
    closeDetailPanel(); renderCurrentView(); renderSidebarProjects();
  };

  // Load history async
  invoke('get_task_history',{taskId:task.id}).then(renderHistory).catch(()=>{});
}
function renderHistory(history) {
  const el=$('history-list'); if(!el) return;
  if(!history.length){el.innerHTML='<span style="font-size:12px;color:var(--text2)">No history yet.</span>';return;}
  el.innerHTML=history.map(h=>{
    const label={created:'Task created',completed:'Marked complete',reopened:'Reopened',edited:'Task edited',moved:h.detail}[h.action]||h.action;
    return `<div class="history-entry ${h.action}">
      <div class="history-content">
        <span class="history-action">${label||h.action}</span>
        ${h.detail&&h.action!=='moved'?`<span class="history-detail">${esc(h.detail)}</span>`:''}
        <span class="history-time">${fmtCreated(h.created_at)}</span>
      </div>
    </div>`;
  }).join('');
}

// ─── Task modal ───────────────────────────────────────────────────────────────
function toLocalInput(iso) {
  const d=new Date(iso),p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function setMdMode(m) {
  const w=m==='write'; $('inp-desc').classList.toggle('hidden',!w); $('md-preview').classList.toggle('hidden',w);
  document.querySelectorAll('.md-tab').forEach(t=>t.classList.toggle('active',t.dataset.mode===m));
  if(!w) $('md-preview').innerHTML=renderMd($('inp-desc').value)||'<em style="color:var(--text2)">Nothing to preview.</em>';
}
function populateProjectSelector() {
  const sel=$('inp-project-sel'),cur=sel.value;
  sel.innerHTML='<option value="">No Project</option>'+projects.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  sel.value=cur;
}
function populateFolderSelector(pid) {
  const sel = $('inp-folder-sel'), cur = sel.value;
  sel.innerHTML = '<option value="">No Folder</option>';
  if (!pid) return;
  const pf = (allFolders[pid] || []);
  function addOpts(list, depth) {
    list.forEach(f => {
      const o = document.createElement('option');
      o.value = f.id; o.textContent = '  '.repeat(depth) + f.name;
      sel.appendChild(o);
      addOpts(pf.filter(x => x.parent_id === f.id), depth + 1);
    });
  }
  addOpts(pf.filter(f => !f.parent_id), 0);
  sel.value = cur;
}
function populateBoardColumnSelector(pid) {
  const sel = $('inp-board-col-sel'), cur = sel.value;
  sel.innerHTML = '<option value="">No Column</option>';
  if (!pid) return;
  const projBoards = allBoards.filter(b => b.project_id === pid);
  for (const board of projBoards) {
    if (!board.columns || !board.columns.length) continue;
    const grp = document.createElement('optgroup');
    grp.label = board.name;
    for (const col of board.columns) {
      const o = document.createElement('option');
      o.value = col.id; o.textContent = col.name;
      grp.appendChild(o);
    }
    sel.appendChild(grp);
  }
  sel.value = cur;
}
function updatePlacementField(pid) {
  $('placement-field').style.display = pid ? '' : 'none';
  if (pid) { populateFolderSelector(pid); populateBoardColumnSelector(pid); }
}
function openModal(task) {
  task = task || null;
  editId = task ? task.id : null;
  priority = task ? task.priority : 'medium';
  const defPid = task ? task.project_id : (currentView === 'project' ? currentProjectId : modalDefaultProjectId);
  const defFid = task ? task.folder_id : (currentFolderId != null ? currentFolderId : modalDefaultFolderId);
  const defColId = task ? task.board_column_id : modalDefaultColumnId;
  $('modal-title').textContent = task ? 'Edit Task' : 'New Task';
  $('btn-submit').textContent = task ? 'Save Changes' : 'Add Task';
  $('field-task-id').textContent = task ? task.task_id : '';
  $('field-task-id').style.display = task ? 'inline-flex' : 'none';
  $('inp-title').value = task ? task.title : '';
  $('inp-desc').value = task ? task.description : '';
  $('inp-due').value = task && task.due_date ? toLocalInput(task.due_date) : '';
  $('inp-notify').value = String(task ? task.notify_before_minutes : 60);
  $('inp-notify').disabled = !$('inp-due').value;
  $('inp-project-sel').value = String(defPid != null ? defPid : '');
  updatePlacementField(defPid);
  if (defFid) $('inp-folder-sel').value = String(defFid);
  if (defColId) $('inp-board-col-sel').value = String(defColId);
  document.querySelectorAll('.priority-btn').forEach(b => b.classList.toggle('active', b.dataset.p === priority));
  $('task-form-error').classList.add('hidden');
  setMdMode('write');
  $('modal-overlay').classList.add('open');
  $('inp-title').focus();
}
function closeModal() {
  $('modal-overlay').classList.remove('open');
  $('form-task').reset();
  editId = null; priority = 'medium';
  modalDefaultProjectId = null; modalDefaultFolderId = null; modalDefaultColumnId = null;
  $('field-task-id').style.display = 'none';
  $('inp-notify').disabled = true;
  $('placement-field').style.display = 'none';
  setMdMode('write');
  document.querySelectorAll('.priority-btn').forEach(b => b.classList.toggle('active', b.dataset.p === 'medium'));
}

// ─── Project modal ────────────────────────────────────────────────────────────
function openProjectModal(id=null) {
  editingProjectId=id;
  const p=id?projects.find(x=>x.id===id):null;
  projectColor=p?p.color:PROJECT_COLORS[0];
  $('project-modal-title').textContent=id?'Edit Project':'New Project';
  $('btn-submit-project').textContent=id?'Save Changes':'Create Project';
  $('inp-project-name').value=p?p.name:''; $('inp-project-desc').value=p?p.description:'';
  $('project-form-error').classList.add('hidden');
  renderColorSwatches(); $('project-modal-overlay').classList.add('open'); $('inp-project-name').focus();
}
function closeProjectModal() { $('project-modal-overlay').classList.remove('open'); editingProjectId=null; }
function renderColorSwatches() {
  $('color-swatches').innerHTML=PROJECT_COLORS.map(c=>`<button type="button" class="color-swatch${c===projectColor?' selected':''}" data-color="${c}" style="background:${c}"></button>`).join('');
  $('color-swatches').querySelectorAll('.color-swatch').forEach(b=>{
    b.addEventListener('click',()=>{ projectColor=b.dataset.color; $('color-swatches').querySelectorAll('.color-swatch').forEach(x=>x.classList.toggle('selected',x.dataset.color===projectColor)); });
  });
}
async function deleteProject(id) {
  const p=projects.find(x=>x.id===id);
  if(!p) return; if(!await showConfirm(`All tasks and boards in "${p.name}" will also be removed.`, { title: 'Delete Project', okLabel: 'Delete Project' })) return;
  await invoke('delete_project',{id});
  projects=projects.filter(x=>x.id!==id); tasks.forEach(t=>{if(t.project_id===id)t.project_id=null;});
  allBoards=allBoards.filter(b=>b.project_id!==id); delete allFolders[id];
  populateProjectSelector(); renderSidebarProjects();
  if(currentProjectId===id) { currentProjectId=null; navigate('tasks'); }
}

// ─── Calendar ─────────────────────────────────────────────────────────────────
function renderCalendar() {
  const now=new Date(), first=new Date(calYear,calMonth,1);
  const start=new Date(first); start.setDate(first.getDate()-first.getDay());
  $('cal-label').textContent=first.toLocaleString('en-US',{month:'long',year:'numeric'});
  const cells=[];const d=new Date(start);
  for(let i=0;i<42;i++){cells.push({date:new Date(d),inMonth:d.getMonth()===calMonth,isToday:d.toDateString()===now.toDateString()});d.setDate(d.getDate()+1);}
  const byDay=new Map();
  for(const t of tasks){if(!t.due_date) continue;const k=new Date(t.due_date).toDateString();if(!byDay.has(k))byDay.set(k,[]);byDay.get(k).push(t);}
  $('cal-grid').innerHTML=cells.map(c=>{
    const k=c.date.toDateString(),dt=byDay.get(k)||[];
    const dots=dt.slice(0,4).map(t=>`<span class="cal-dot" style="background:${t.priority==='high'?'#f87171':t.priority==='medium'?'#fbbf24':'#4ade80'}${t.completed?'60':''}"></span>`).join('');
    return `<div class="cal-cell${c.inMonth?'':' other-month'}${c.isToday?' today':''}${dt.length?' has-tasks':''}" data-date="${c.date.toISOString()}">
      <span class="cal-date">${c.date.getDate()}</span><div class="cal-dots">${dots}</div></div>`;
  }).join('');
  $('cal-grid').querySelectorAll('.cal-cell').forEach(cell=>cell.addEventListener('click',()=>showDayPanel(cell.dataset.date)));
}
function showDayPanel(iso) {
  calSelected=iso;
  const d=new Date(iso),k=d.toDateString();
  const dt=tasks.filter(t=>t.due_date&&new Date(t.due_date).toDateString()===k);
  $('day-panel-title').textContent=d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  $('day-panel').classList.remove('hidden');
  $('day-panel-list').innerHTML=!dt.length?'<div style="padding:8px;color:var(--text2);font-size:13px">No tasks on this day.</div>':
    dt.map(t=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer" class="day-task-row" data-id="${t.id}">
      <span class="task-check${t.completed?' checked':''}" data-check="${t.id}" style="flex-shrink:0"></span>
      <span style="flex:1;font-size:13px;${t.completed?'text-decoration:line-through;color:var(--text2)':''}">${esc(t.title)}</span>
      <span class="badge ${t.priority}">${t.priority}</span></div>`).join('');
  $('day-panel-list').querySelectorAll('.day-task-row').forEach(row=>{
    row.addEventListener('click',e=>{if(e.target.closest('.task-check')) return;const t=tasks.find(x=>x.id===Number(row.dataset.id));if(t){selectedTaskId=t.id;openDetailPanel(t);}});
  });
  $('day-panel-list').querySelectorAll('.task-check').forEach(el=>{
    el.addEventListener('click',async e=>{e.stopPropagation();const id=Number(el.dataset.check);const done=await invoke('toggle_task',{id});const t=tasks.find(x=>x.id===id);if(t)t.completed=done;showDayPanel(iso);});
  });
  renderCalendar();
}

// ─── Wire-up ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Login
  $('form-login').addEventListener('submit', async e => {
    e.preventDefault();
    const email=$('inp-email').value.trim(), password=$('inp-password').value, remember=$('chk-remember').checked;
    const err=$('login-error'); err.classList.add('hidden');
    try {
      const r=await invoke('login',{email,password}); sessionToken=r.token; saveToken(r.token,remember); showApp(r.user);
    } catch(e) { err.textContent=String(e); err.classList.remove('hidden'); }
  });
  $('btn-pw-toggle').addEventListener('click',()=>{
    const i=$('inp-password'),show=i.type==='password'; i.type=show?'text':'password';
    $('eye-show').style.display=show?'none':''; $('eye-hide').style.display=show?'':'none';
  });

  // Sidebar nav
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));
  $('btn-logout').addEventListener('click',async()=>{
    if(sessionToken) try{await invoke('logout',{token:sessionToken})}catch(_){}
    clearToken(); sessionToken=null;
    $('screen-app').classList.add('hidden'); $('screen-login').classList.remove('hidden'); $('inp-password').value='';
  });

  // New task
  $('btn-new').addEventListener('click',()=>openModal());
  $('btn-close-modal').addEventListener('click',closeModal);
  $('btn-cancel').addEventListener('click',closeModal);
  $('modal-overlay').addEventListener('click',e=>{if(e.target===$('modal-overlay'))closeModal();});

  // Priority
  document.querySelectorAll('.priority-btn').forEach(b=>b.addEventListener('click',()=>{
    priority=b.dataset.p; document.querySelectorAll('.priority-btn').forEach(x=>x.classList.toggle('active',x.dataset.p===priority));
  }));
  $('inp-due').addEventListener('change',()=>$('inp-notify').disabled=!$('inp-due').value);
  document.querySelectorAll('.md-tab').forEach(t=>t.addEventListener('click',()=>setMdMode(t.dataset.mode)));

  // Confirm dialog
  $('confirm-ok').addEventListener('click', () => _closeConfirm(true));
  $('confirm-cancel').addEventListener('click', () => _closeConfirm(false));
  $('confirm-overlay').addEventListener('click', e => { if (e.target === $('confirm-overlay')) _closeConfirm(false); });

  // Project selector updates placement field
  $('inp-project-sel').addEventListener('change', () => {
    const pid = $('inp-project-sel').value ? parseInt($('inp-project-sel').value) : null;
    updatePlacementField(pid);
  });

  // Placement field mutual exclusion: selecting folder clears board col and vice-versa
  $('inp-folder-sel').addEventListener('change', () => {
    if ($('inp-folder-sel').value) $('inp-board-col-sel').value = '';
  });
  $('inp-board-col-sel').addEventListener('change', () => {
    if ($('inp-board-col-sel').value) $('inp-folder-sel').value = '';
  });

  // Task form submit
  const btnSub=$('btn-submit');
  $('form-task').addEventListener('submit', async e => {
    e.preventDefault();
    const title=$('inp-title').value.trim(), description=$('inp-desc').value.trim();
    const dueDate=$('inp-due').value?new Date($('inp-due').value).toISOString():null;
    const notifyBeforeMinutes=parseInt($('inp-notify').value,10);
    const projectId=$('inp-project-sel').value?parseInt($('inp-project-sel').value):null;
    const folderId=$('inp-folder-sel').value?parseInt($('inp-folder-sel').value):null;
    const boardColumnId=$('inp-board-col-sel').value?parseInt($('inp-board-col-sel').value):null;
    const err=$('task-form-error');
    if(!title) return;
    err.classList.add('hidden'); btnSub.disabled=true; btnSub.textContent='Saving…';
    try {
      if(editId!==null) {
        const upd=await invoke('update_task',{id:editId,title,description,priority,dueDate,notifyBeforeMinutes,projectId,folderId,boardColumnId});
        const i=tasks.findIndex(t=>t.id===editId); if(i!==-1) tasks[i]=upd;
        if(selectedTaskId===editId) renderDetailPanel(upd);
      } else {
        const t=await invoke('create_task',{title,description,priority,dueDate,notifyBeforeMinutes,projectId,folderId,boardColumnId});
        tasks.unshift(t);
      }
      closeModal(); renderCurrentView(); renderSidebarProjects();
    } catch(e) { err.textContent=String(e); err.classList.remove('hidden'); }
    finally { btnSub.disabled=false; btnSub.textContent=editId?'Save Changes':'Add Task'; }
  });

  // Task filters
  $('task-filter-bar').querySelectorAll('.filter-btn').forEach(b=>b.addEventListener('click',()=>{
    filter=b.dataset.filter; $('task-filter-bar').querySelectorAll('.filter-btn').forEach(x=>x.classList.toggle('active',x.dataset.filter===filter)); renderTasks();
  }));
  $('btn-mode-flat').addEventListener('click',()=>{ taskViewMode='flat'; $('btn-mode-flat').classList.add('active'); $('btn-mode-grouped').classList.remove('active'); renderTasks(); });
  $('btn-mode-grouped').addEventListener('click',()=>{ taskViewMode='grouped'; $('btn-mode-grouped').classList.add('active'); $('btn-mode-flat').classList.remove('active'); renderTasks(); });

  // Detail panel
  $('btn-close-detail').addEventListener('click',closeDetailPanel);

  // Calendar
  $('cal-prev').addEventListener('click',()=>{ calMonth--;if(calMonth<0){calMonth=11;calYear--;}renderCalendar(); });
  $('cal-next').addEventListener('click',()=>{ calMonth++;if(calMonth>11){calMonth=0;calYear++;}renderCalendar(); });
  $('btn-close-day').addEventListener('click',()=>{ calSelected=null; $('day-panel').classList.add('hidden'); renderCalendar(); });

  // Project modal
  $('btn-new-project').addEventListener('click',()=>openProjectModal());
  $('btn-close-project-modal').addEventListener('click',closeProjectModal);
  $('btn-cancel-project').addEventListener('click',closeProjectModal);
  $('project-modal-overlay').addEventListener('click',e=>{if(e.target===$('project-modal-overlay'))closeProjectModal();});
  $('form-project').addEventListener('submit', async e => {
    e.preventDefault();
    const name=$('inp-project-name').value.trim(), description=$('inp-project-desc').value.trim(), color=projectColor;
    const err=$('project-form-error'),btn=$('btn-submit-project');
    err.classList.add('hidden'); btn.disabled=true; btn.textContent='Saving…';
    try {
      if(editingProjectId){const u=await invoke('update_project',{id:editingProjectId,name,description,color});const i=projects.findIndex(p=>p.id===editingProjectId);if(i!==-1)projects[i]=u;}
      else{const p=await invoke('create_project',{name,description,color});projects.push(p);projects.sort((a,b)=>a.name.localeCompare(b.name));}
      closeProjectModal(); populateProjectSelector(); renderSidebarProjects(); renderCurrentView();
    } catch(e){err.textContent=String(e);err.classList.remove('hidden');}
    finally{btn.disabled=false;btn.textContent=editingProjectId?'Save Changes':'Create Project';}
  });

  $('btn-add-col') && $('btn-add-col').addEventListener('click',()=>openColModal());

  // Column modal
  $('btn-close-col-modal').addEventListener('click',closeColModal);
  $('btn-cancel-col').addEventListener('click',closeColModal);
  $('col-modal-overlay').addEventListener('click',e=>{if(e.target===$('col-modal-overlay'))closeColModal();});
  $('form-col').addEventListener('submit', async e=>{
    e.preventDefault();
    const name=$('inp-col-name').value.trim(), color=colColor;
    const err=$('col-form-error'),btn=$('btn-submit-col');
    err.classList.add('hidden'); btn.disabled=true; btn.textContent='Saving…';
    try {
      if(editingColId){
        await invoke('update_board_column',{id:editingColId,name,color});
      } else {
        await invoke('create_board_column',{boardId:currentBoardId,name,color});
      }
      allBoards = allBoards.filter(b => b.project_id !== currentProjectId).concat(
        await invoke('get_boards', { projectId: currentProjectId }));
      renderSidebarProjects(); closeColModal(); await renderBoardView(currentBoardId);
    } catch(e){err.textContent=String(e);err.classList.remove('hidden');}
    finally{btn.disabled=false;btn.textContent=editingColId?'Save':'Add Column';}
  });

  // Folder filter bar
  $('folder-filter-bar').querySelectorAll('.filter-btn').forEach(b => b.addEventListener('click', () => {
    folderFilter = b.dataset.filter;
    $('folder-filter-bar').querySelectorAll('.filter-btn').forEach(x => x.classList.toggle('active', x.dataset.filter === folderFilter));
    if (currentView === 'folder-tasks') renderFolderView(currentFolderId);
  }));
  $('btn-add-folder-task').addEventListener('click', () => {
    modalDefaultFolderId = currentFolderId;
    modalDefaultProjectId = currentProjectId;
    openModal(null);
  });

  // Escape
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      if(!$('confirm-overlay').classList.contains('hidden')){_closeConfirm(false);return;}
      if($('col-modal-overlay').classList.contains('open')){closeColModal();return;}
      if($('modal-overlay').classList.contains('open')){closeModal();return;}
      if($('project-modal-overlay').classList.contains('open')){closeProjectModal();return;}
      if(selectedTaskId) closeDetailPanel();
    }
  });

  initAuth();
});
