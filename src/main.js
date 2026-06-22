const { invoke } = window.__TAURI__.core;

// ─── State ────────────────────────────────────────────────────────────────────
let tasks = [], projects = [], folders = [], boards = [], allBoards = [];
let filter = 'all', projectFilter = 'all';
let priority = 'medium';
let editId = null, sessionToken = null;
let calYear = new Date().getFullYear(), calMonth = new Date().getMonth(), calSelected = null;
let currentView = 'tasks', currentProjectId = null;
let taskViewMode = 'flat';
let selectedTaskId = null;
let editingProjectId = null, projectColor = '#7c6af7';
let expandedProjects = new Set();
let modalDefaultProjectId = null, modalDefaultFolderId = null, modalDefaultColumnId = null;
let currentFolderId = null;   // null = show all tasks in project
let currentBoardId  = null;
let editingProjectTabId = 'tasks';
let colColor = '#6b7280', editingColId = null;

const PROJECT_COLORS = ['#7c6af7','#60a5fa','#4ade80','#fbbf24','#f87171','#f472b6','#fb923c','#2dd4bf'];

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

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
    const perProject = await Promise.all(projects.map(p => invoke('get_boards', { projectId: p.id })));
    allBoards = perProject.flat();
  } else {
    allBoards = [];
  }
  renderSidebarProjects(); populateProjectSelector(); renderCurrentView();
}

// ─── Navigation ──────────────────────────────────────────────────────────────
async function navigate(view, pid=null) {
  currentView=view; currentProjectId=pid; selectedTaskId=null; closeDetailPanel();
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.view===view && !pid));
  document.querySelectorAll('.project-nav-item').forEach(i => i.classList.toggle('active', Number(i.dataset.pid)===pid));
  $('view-tasks').classList.toggle('hidden', view!=='tasks');
  $('view-calendar').classList.toggle('hidden', view!=='calendar');
  $('view-project').classList.toggle('hidden', view!=='project');
  await renderCurrentView();
}
async function renderCurrentView() {
  if (currentView==='tasks')    { renderTasks(); renderStats(); }
  if (currentView==='calendar') renderCalendar();
  if (currentView==='project' && currentProjectId) await renderProjectView(currentProjectId);
}
async function navigateToBoard(pid, bid) {
  currentBoardId = bid;
  expandedProjects.add(pid);
  await navigate('project', pid);
  switchProjTab('board');
  const sel = $('board-selector');
  if (sel) sel.value = String(bid);
  const b = boards.find(x => x.id === bid);
  if (b) renderBoard(b);
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function renderSidebarProjects() {
  const el = $('sidebar-project-list');
  if (!projects.length) {
    el.innerHTML = '<div style="padding:6px 10px;font-size:12px;color:var(--text2)">No projects yet</div>';
    return;
  }
  // Auto-expand the active project
  if (currentProjectId) expandedProjects.add(currentProjectId);

  el.innerHTML = projects.map(p => {
    const taskCount = tasks.filter(t => t.project_id === p.id).length;
    const projBoards = allBoards.filter(b => b.project_id === p.id);
    const isActive = currentProjectId === p.id;
    const isExpanded = expandedProjects.has(p.id);

    const boardsHtml = (isExpanded && projBoards.length) ? `
      <div class="project-nav-boards">
        ${projBoards.map(b => `
          <button class="board-nav-item${(isActive && currentBoardId === b.id) ? ' active' : ''}" data-pid="${p.id}" data-bid="${b.id}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="5" height="18" rx="1"/>
              <rect x="10" y="3" width="5" height="12" rx="1"/>
              <rect x="17" y="3" width="5" height="8" rx="1"/>
            </svg>
            <span class="board-nav-name">${esc(b.name)}</span>
          </button>`).join('')}
      </div>` : '';

    return `<div class="sidebar-project-group">
      <div class="project-nav-row${isActive ? ' active' : ''}">
        <button class="project-nav-chevron${isExpanded ? ' expanded' : ''}" data-pid="${p.id}" title="Toggle boards">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="project-nav-item" data-pid="${p.id}">
          <span class="project-nav-dot" style="background:${p.color}"></span>
          <span class="project-nav-name">${esc(p.name)}</span>
          ${taskCount ? `<span class="project-nav-count">${taskCount}</span>` : ''}
        </button>
      </div>
      ${boardsHtml}
    </div>`;
  }).join('');

  el.querySelectorAll('.project-nav-item').forEach(b =>
    b.addEventListener('click', () => {
      const pid = Number(b.dataset.pid);
      expandedProjects.add(pid);
      navigate('project', pid);
    })
  );
  el.querySelectorAll('.project-nav-chevron').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const pid = Number(btn.dataset.pid);
      if (expandedProjects.has(pid)) expandedProjects.delete(pid);
      else expandedProjects.add(pid);
      renderSidebarProjects();
    })
  );
  el.querySelectorAll('.board-nav-item').forEach(btn =>
    btn.addEventListener('click', () => navigateToBoard(Number(btn.dataset.pid), Number(btn.dataset.bid)))
  );
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

// ─── Task cards ───────────────────────────────────────────────────────────────
function applyFilter(list, f) { return f==='active'?list.filter(t=>!t.completed):f==='completed'?list.filter(t=>t.completed):list; }

function taskCardHTML(task, showProject=true) {
  const proj = task.project_id ? projects.find(p=>p.id===task.project_id) : null;
  const due  = dueMeta(task.due_date);
  const desc = stripMd(task.description);
  return `<div class="task-card${task.completed?' done':''}${selectedTaskId===task.id?' selected':''}" data-id="${task.id}">
    <div class="task-check${task.completed?' checked':''}" data-check="${task.id}"></div>
    <div class="task-body">
      <div class="task-title-row">
        <span class="task-title${task.completed?' done':''}">${esc(task.title)}</span>
        <span class="task-id">${task.task_id}</span>
        <span class="badge ${task.priority}">${task.priority}</span>
      </div>
      <div class="task-meta-row">
        ${showProject&&proj?`<span class="project-chip" style="background:${proj.color}18;color:${proj.color}"><span class="project-chip-dot" style="background:${proj.color}"></span>${esc(proj.name)}</span>`:''}
        ${due?`<span class="due-chip ${due.cls}">${due.html}</span>`:''}
        ${desc?`<span class="task-desc-preview">${esc(desc)}</span>`:''}
      </div>
    </div>
    <div class="task-actions">
      <button class="edit-btn" data-id="${task.id}" title="Edit"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
      <button class="del-btn" data-id="${task.id}" title="Delete"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
    </div>
  </div>`;
}

function attachCardListeners(container) {
  container.querySelectorAll('.task-check').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation();
      const id = Number(el.dataset.check);
      const done = await invoke('toggle_task',{id});
      const t = tasks.find(t=>t.id===id); if(t) t.completed=done;
      if(selectedTaskId===id) renderDetailPanel(tasks.find(t=>t.id===id));
      renderCurrentView(); renderSidebarProjects();
    });
  });
  container.querySelectorAll('.edit-btn').forEach(el => {
    el.addEventListener('click', e => { e.stopPropagation(); openModal(tasks.find(t=>t.id===Number(el.dataset.id))); });
  });
  container.querySelectorAll('.del-btn').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation();
      const id = Number(el.dataset.id);
      if (!confirm('Delete this task?')) return;
      await invoke('delete_task',{id}); tasks=tasks.filter(t=>t.id!==id);
      if(selectedTaskId===id) closeDetailPanel();
      renderCurrentView(); renderSidebarProjects();
    });
  });
  container.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('click', e => {
      if(e.target.closest('.task-check,.edit-btn,.del-btn')) return;
      const id=Number(card.dataset.id);
      if(selectedTaskId===id){closeDetailPanel();return;}
      selectedTaskId=id; openDetailPanel(tasks.find(t=>t.id===id));
      document.querySelectorAll('.task-card').forEach(c=>c.classList.toggle('selected',Number(c.dataset.id)===id));
    });
  });
}

// ─── All Tasks View ───────────────────────────────────────────────────────────
function renderTasks() {
  const filtered = applyFilter(tasks, filter);
  const list = $('task-list');
  if (!filtered.length) {
    list.innerHTML=`<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><p>${filter==='completed'?'No completed tasks.':'No tasks yet!'}</p></div>`;
    return;
  }
  if (taskViewMode==='grouped') renderGrouped(list,filtered);
  else { list.innerHTML=filtered.map(t=>taskCardHTML(t)).join(''); attachCardListeners(list); }
}
function renderGrouped(container, taskList) {
  const byProject=new Map();
  for(const t of taskList){const k=t.project_id??0;if(!byProject.has(k))byProject.set(k,[]);byProject.get(k).push(t);}
  let html='';
  for(const p of projects){if(byProject.has(p.id)){html+=`<div class="task-group-header"><span class="task-group-dot" style="background:${p.color}"></span><span>${esc(p.name)}</span><span class="task-group-count">${byProject.get(p.id).length}</span></div>`;html+=byProject.get(p.id).map(t=>taskCardHTML(t,false)).join('');}}
  if(byProject.has(0)){html+=`<div class="task-group-header"><span>No Project</span><span class="task-group-count">${byProject.get(0).length}</span></div>`;html+=byProject.get(0).map(t=>taskCardHTML(t)).join('');}
  if(!html){container.innerHTML='<div class="empty-state"><p>No tasks.</p></div>';return;}
  container.innerHTML=html; attachCardListeners(container);
}

// ─── Project View ─────────────────────────────────────────────────────────────
async function renderProjectView(pid) {
  const proj = projects.find(p=>p.id===pid);
  if (!proj) { navigate('tasks'); return; }

  // Load folders and boards for this project
  [folders, boards] = await Promise.all([
    invoke('get_folders',{projectId:pid}),
    invoke('get_boards',{projectId:pid}),
  ]);
  // Sync allBoards so the sidebar stays current
  allBoards = allBoards.filter(b => b.project_id !== pid).concat(boards);
  if (!currentBoardId && boards.length) currentBoardId = boards[0].id;

  // Project header
  const projTasks=tasks.filter(t=>t.project_id===pid);
  const done=projTasks.filter(t=>t.completed).length, total=projTasks.length;
  const pct=total>0?Math.round(done/total*100):0;
  $('project-view-header').innerHTML=`
    <div class="pvh-color-bar" style="background:${proj.color}"></div>
    <div class="pvh-body">
      <div class="pvh-left">
        <div class="pvh-title"><span class="pvh-dot" style="background:${proj.color}"></span><h2>${esc(proj.name)}</h2></div>
        ${proj.description?`<p class="pvh-desc">${esc(proj.description)}</p>`:''}
        <div class="pvh-stats"><span>${total} tasks · ${done} done · ${total-done} active</span><div class="pvh-progress"><div class="pvh-progress-fill" style="width:${pct}%;background:${proj.color}"></div></div><span>${pct}%</span></div>
      </div>
      <div class="pvh-actions">
        <button class="btn-secondary btn-sm" id="pvh-edit">Edit</button>
        <button class="btn-danger btn-sm" id="pvh-del">Delete</button>
      </div>
    </div>`;
  $('pvh-edit').addEventListener('click',()=>openProjectModal(proj.id));
  $('pvh-del').addEventListener('click',()=>deleteProject(proj.id));

  // Folder tree
  renderFolderTree(pid);
  populateFolderSelector(pid);

  // Tasks tab
  renderProjectTaskList(pid);

  // Board tab
  renderBoardTab();
}

function renderProjectTaskList(pid) {
  const folderFiltered = currentFolderId
    ? tasks.filter(t=>t.project_id===pid && t.folder_id===currentFolderId)
    : tasks.filter(t=>t.project_id===pid);
  const filtered=applyFilter(folderFiltered, projectFilter);
  const list=$('project-task-list');
  if(!filtered.length){list.innerHTML=`<div class="empty-state"><p>No tasks${projectFilter!=='all'?' matching filter':currentFolderId?' in this folder':' in this project'}.</p></div>`;return;}
  list.innerHTML=filtered.map(t=>taskCardHTML(t,false)).join('');
  attachCardListeners(list);
}

// no-op: tabs replaced by always-visible sections
function switchProjTab(_tab) {}

// ─── Folder tree ──────────────────────────────────────────────────────────────
function renderFolderTree(pid) {
  const tree = $('folder-tree');
  const count = tasks.filter(t=>t.project_id===pid).length;
  let html = `<button class="all-tasks-btn${!currentFolderId?' active':''}" id="btn-all-folder-tasks">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
    All Tasks <span style="margin-left:auto;opacity:.6">${count}</span>
  </button>`;
  const roots=folders.filter(f=>!f.parent_id);
  html+=renderFolderNodes(roots,pid,0);
  tree.innerHTML=html;

  tree.querySelector('#btn-all-folder-tasks').addEventListener('click',()=>{
    currentFolderId=null;
    tree.querySelectorAll('.all-tasks-btn').forEach(b=>b.classList.add('active'));
    tree.querySelectorAll('.folder-item').forEach(b=>b.classList.remove('active'));
    renderProjectTaskList(pid);
  });
  tree.querySelectorAll('.folder-btn[data-fid]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      currentFolderId=Number(btn.dataset.fid);
      tree.querySelectorAll('.all-tasks-btn').forEach(b=>b.classList.remove('active'));
      tree.querySelectorAll('.folder-item').forEach(b=>b.classList.toggle('active',Number(b.dataset.fid)===currentFolderId));
      renderProjectTaskList(pid);
    });
  });
  tree.querySelectorAll('.add-subfolder-btn').forEach(btn=>{
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const name=prompt('Subfolder name:'); if(!name) return;
      const f=await invoke('create_folder',{projectId:pid,parentId:Number(btn.dataset.parent),name});
      folders.push(f); renderFolderTree(pid); populateFolderSelector(pid);
    });
  });
  tree.querySelectorAll('.rename-f-btn').forEach(btn=>{
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id=Number(btn.dataset.fid);
      const f=folders.find(f=>f.id===id); if(!f) return;
      const name=prompt('Rename folder:',f.name); if(!name||name===f.name) return;
      const upd=await invoke('rename_folder',{id,name});
      const i=folders.findIndex(x=>x.id===id); if(i!==-1) folders[i]=upd;
      renderFolderTree(pid); populateFolderSelector(pid);
    });
  });
  tree.querySelectorAll('.del-f-btn').forEach(btn=>{
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id=Number(btn.dataset.fid);
      const f=folders.find(x=>x.id===id);
      if(!confirm(`Delete folder "${f?.name}"? Tasks will be unlinked.`)) return;
      await invoke('delete_folder',{id});
      folders=folders.filter(x=>x.id!==id);
      tasks.forEach(t=>{if(t.folder_id===id)t.folder_id=null;});
      if(currentFolderId===id) currentFolderId=null;
      renderFolderTree(pid); populateFolderSelector(pid); renderProjectTaskList(pid);
    });
  });
}

function renderFolderNodes(list,pid,depth) {
  return list.map(f=>{
    const kids=folders.filter(x=>x.parent_id===f.id);
    const count=tasks.filter(t=>t.project_id===pid&&t.folder_id===f.id).length;
    const indent=depth*14;
    return `<div class="folder-item${currentFolderId===f.id?' active':''}" data-fid="${f.id}" style="padding-left:${indent}px">
      <button class="folder-btn" data-fid="${f.id}">
        <svg class="folder-chevron${kids.length?'':' hidden'}" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <span class="folder-name">${esc(f.name)}</span>
        <span style="font-size:10px;color:var(--text2);opacity:.7">${count||''}</span>
      </button>
      <div class="folder-item-actions">
        <button class="add-subfolder-btn" data-parent="${f.id}" title="Add subfolder"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <button class="rename-f-btn" data-fid="${f.id}" title="Rename"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="del-f-btn" data-fid="${f.id}" title="Delete"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
      </div>
    </div>
    ${kids.length?`<div class="folder-children">${renderFolderNodes(kids,pid,depth+1)}</div>`:''}`;
  }).join('');
}

// ─── Board view ───────────────────────────────────────────────────────────────
function renderBoardTab() {
  const hasBoards = boards.length > 0;
  $('board-canvas').classList.toggle('hidden', !hasBoards);
  $('board-empty').classList.toggle('hidden', hasBoards);
  const actions = $('board-section-actions');
  actions.querySelectorAll('select,button:not(#btn-new-board)').forEach(el => {
    el.style.display = hasBoards ? '' : 'none';
  });
  if (!hasBoards) return;

  const sel = $('board-selector');
  sel.innerHTML = boards.map(b =>
    `<option value="${b.id}"${b.id===currentBoardId?' selected':''}>${esc(b.name)}</option>`
  ).join('');

  const board = boards.find(b => b.id === currentBoardId) || boards[0];
  if (!board) return;
  currentBoardId = board.id;
  renderBoard(board);
}

const PRIORITY_COLORS = { high:'#f87171', medium:'#fbbf24', low:'#4ade80' };

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
      const currentBoard = boards.find(b => b.id === currentBoardId) || board;
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
        renderBoard(boards.find(b => b.id === currentBoardId) || board);
      }
    });

    colEl.querySelector('.board-col-add-btn').addEventListener('click', () => {
      modalDefaultColumnId = col.id; openModal(null);
    });
    colEl.querySelector('.col-edit-btn').addEventListener('click', () => {
      openColModal(col.id, col.name, col.color);
    });
    colEl.querySelector('.col-del-btn')?.addEventListener('click', async () => {
      if (!confirm(`Delete column "${col.name}"? Tasks will become unassigned.`)) return;
      await invoke('delete_board_column', { id: col.id });
      tasks.forEach(t => { if (t.board_column_id === col.id) t.board_column_id = null; });
      boards = await invoke('get_boards', { projectId: currentProjectId });
      const b = boards.find(b => b.id === currentBoardId);
      if (b) renderBoard(b); else renderBoardTab();
    });

    canvas.appendChild(colEl);
  }
}

function makeBoardCard(task) {
  const due = dueMeta(task.due_date);
  const priColor = PRIORITY_COLORS[task.priority] || '#6b7280';
  const folder = task.folder_id ? folders.find(f => f.id === task.folder_id) : null;

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
    const currentBoard = boards.find(b => b.id === currentBoardId);
    if (currentBoard) renderBoard(currentBoard);
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
    if(!confirm('Delete this task?')) return;
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
  const sel=$('inp-folder-sel'),cur=sel.value;
  sel.innerHTML='<option value="">No Folder</option>';
  const pf=folders.filter(f=>f.project_id===pid);
  function addOpts(list,depth){list.forEach(f=>{const o=document.createElement('option');o.value=f.id;o.textContent='  '.repeat(depth)+f.name;sel.appendChild(o);addOpts(pf.filter(x=>x.parent_id===f.id),depth+1);});}
  addOpts(pf.filter(f=>!f.parent_id),0);
  sel.value=cur;
  $('folder-field').style.display=pid&&pf.length?'':'none';
}
function openModal(task=null) {
  editId=task?task.id:null; priority=task?task.priority:'medium';
  const defPid=task?task.project_id:(currentView==='project'?currentProjectId:modalDefaultProjectId);
  const defFid=task?task.folder_id:(currentFolderId??modalDefaultFolderId);
  $('modal-title').textContent=task?'Edit Task':'New Task';
  $('btn-submit').textContent=task?'Save Changes':'Add Task';
  $('field-task-id').textContent=task?task.task_id:''; $('field-task-id').style.display=task?'inline-flex':'none';
  $('inp-title').value=task?task.title:''; $('inp-desc').value=task?task.description:'';
  $('inp-due').value=task&&task.due_date?toLocalInput(task.due_date):'';
  $('inp-notify').value=String(task?task.notify_before_minutes:60);
  $('inp-notify').disabled=!$('inp-due').value;
  $('inp-project-sel').value=String(defPid??'');
  populateFolderSelector(defPid); $('inp-folder-sel').value=String(defFid??'');
  document.querySelectorAll('.priority-btn').forEach(b=>b.classList.toggle('active',b.dataset.p===priority));
  $('task-form-error').classList.add('hidden'); setMdMode('write');
  $('modal-overlay').classList.add('open'); $('inp-title').focus();
}
function closeModal() {
  $('modal-overlay').classList.remove('open'); $('form-task').reset();
  editId=null; priority='medium'; modalDefaultProjectId=null; modalDefaultFolderId=null; modalDefaultColumnId=null;
  $('field-task-id').style.display='none'; $('inp-notify').disabled=true; $('folder-field').style.display='none';
  setMdMode('write');
  document.querySelectorAll('.priority-btn').forEach(b=>b.classList.toggle('active',b.dataset.p==='medium'));
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
  if(!p||!confirm(`Delete project "${p.name}"?`)) return;
  await invoke('delete_project',{id});
  projects=projects.filter(x=>x.id!==id); tasks.forEach(t=>{if(t.project_id===id)t.project_id=null;});
  populateProjectSelector(); renderSidebarProjects();
  if(currentProjectId===id) navigate('tasks');
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

  // Project selector updates folder list
  $('inp-project-sel').addEventListener('change',()=>{
    const pid=$('inp-project-sel').value?parseInt($('inp-project-sel').value):null;
    populateFolderSelector(pid);
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
    const boardColumnId=modalDefaultColumnId||null;
    const err=$('task-form-error');
    if(!title) return;
    err.classList.add('hidden'); btnSub.disabled=true; btnSub.textContent='Saving…';
    try {
      if(editId!==null) {
        const upd=await invoke('update_task',{id:editId,title,description,priority,dueDate,notifyBeforeMinutes,projectId,folderId});
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

  // Project filter bar
  $('project-filter-bar').querySelectorAll('.filter-btn').forEach(b=>b.addEventListener('click',()=>{
    projectFilter=b.dataset.filter; $('project-filter-bar').querySelectorAll('.filter-btn').forEach(x=>x.classList.toggle('active',x.dataset.filter===projectFilter));
    if(currentView==='project') renderProjectTaskList(currentProjectId);
  }));
  $('btn-add-project-task').addEventListener('click',()=>openModal());

  // Project tabs
  document.querySelectorAll('.proj-tab').forEach(b=>b.addEventListener('click',()=>switchProjTab(b.dataset.ptab)));

  // Folder root add
  $('btn-add-root-folder').addEventListener('click', async () => {
    const name=prompt('Folder name:'); if(!name) return;
    const f=await invoke('create_folder',{projectId:currentProjectId,parentId:null,name});
    folders.push(f); renderFolderTree(currentProjectId); populateFolderSelector(currentProjectId);
  });

  // Board controls
  $('board-selector').addEventListener('change',()=>{
    currentBoardId=parseInt($('board-selector').value);
    const b=boards.find(x=>x.id===currentBoardId); if(b) renderBoard(b);
  });
  $('btn-new-board').addEventListener('click', async ()=>{
    const name=prompt('Board name:','My Board'); if(!name) return;
    const b=await invoke('create_board',{projectId:currentProjectId,name});
    boards.push(b); currentBoardId=b.id; renderBoardTab();
  });
  $('btn-create-first-board').addEventListener('click', async ()=>{
    const name=prompt('Board name:','My Board'); if(!name) return;
    const b=await invoke('create_board',{projectId:currentProjectId,name});
    boards.push(b); currentBoardId=b.id; renderBoardTab();
  });
  $('btn-rename-board').addEventListener('click', async ()=>{
    const b=boards.find(x=>x.id===currentBoardId); if(!b) return;
    const name=prompt('New name:',b.name); if(!name||name===b.name) return;
    const upd=await invoke('rename_board',{id:currentBoardId,name});
    const i=boards.findIndex(x=>x.id===currentBoardId); if(i!==-1) boards[i]=upd;
    renderBoardTab();
  });
  $('btn-delete-board').addEventListener('click', async ()=>{
    const b=boards.find(x=>x.id===currentBoardId);
    if(!b||!confirm(`Delete board "${b.name}"?`)) return;
    await invoke('delete_board',{id:currentBoardId});
    boards=boards.filter(x=>x.id!==currentBoardId);
    currentBoardId=boards[0]?.id||null; renderBoardTab();
  });
  $('btn-add-col').addEventListener('click',()=>openColModal());

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
      const updBoards=await invoke('get_boards',{projectId:currentProjectId});
      boards=updBoards; const b=boards.find(x=>x.id===currentBoardId);
      closeColModal(); if(b) renderBoard(b); else renderBoardTab();
    } catch(e){err.textContent=String(e);err.classList.remove('hidden');}
    finally{btn.disabled=false;btn.textContent=editingColId?'Save':'Add Column';}
  });

  // Escape
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      if($('col-modal-overlay').classList.contains('open')){closeColModal();return;}
      if($('modal-overlay').classList.contains('open')){closeModal();return;}
      if($('project-modal-overlay').classList.contains('open')){closeProjectModal();return;}
      if(selectedTaskId) closeDetailPanel();
    }
  });

  initAuth();
});
