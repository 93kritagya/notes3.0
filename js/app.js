/* ══════════════════════════════════════════════
   STORAGE FORMAT: notes-data.json
   {
     "version": 3,
     "exported": "2024-01-01T00:00:00.000Z",
     "notes":   [ { id, title, body, tag, folderId, updated, imported, sourceFile }, ... ],
     "folders": [ { id, name }, ... ]
   }
   (version 2 / plain-array files still load fine, folders default to [])
   ══════════════════════════════════════════════ */

  const LS_NOTES   = 'my-notes-v3';
  const LS_FOLDERS = 'my-notes-folders-v1';
  const LS_TABS    = 'my-notes-tabs-v1';
  const LS_GH      = 'my-notes-github-v2';

  /* Safe localStorage access — some sandboxed/preview browser contexts block storage
     entirely and throw a SecurityError on the very first access, which (if unguarded)
     would halt this whole script and break every button. Fall back to an in-memory
     store so the app still works for the session even without persistence. */
  const memoryStore = {};
  function lsGet(key) { try { return localStorage.getItem(key); } catch { return memoryStore[key] ?? null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch { memoryStore[key] = val; } }
  const TAG_COLORS = {
    work:     { bg: 'rgba(79,216,255,0.14)',  color: '#4fd8ff' },
    personal: { bg: 'rgba(77,255,180,0.14)',  color: '#4dffb4' },
    ideas:    { bg: 'rgba(181,140,255,0.16)', color: '#c9a8ff' },
    todo:     { bg: 'rgba(255,190,90,0.16)',  color: '#ffbe5a' },
  };

  /* ── JSON serialise / parse ── */
  function notesToJSON(notesArr, foldersArr) {
    return JSON.stringify({ version: 3, exported: new Date().toISOString(), notes: notesArr, folders: foldersArr }, null, 2);
  }
  function jsonToData(text) {
    const obj = JSON.parse(text);
    // Support new {notes,folders} format, legacy {notes} format, and plain array
    if (obj && Array.isArray(obj.notes)) return { notes: obj.notes, folders: Array.isArray(obj.folders) ? obj.folders : [] };
    if (Array.isArray(obj)) return { notes: obj, folders: [] };
    throw new Error('Invalid JSON format. Expected { notes: [...] }');
  }

  /* ── State ── */
  let notes = [], folders = [], activeId = null, filterTag = '', folderFilter = '', openTabIds = [], isDirty = false, loadedFrom = null;
  let expandedFolders = new Set(); // which folders are expanded in the sidebar tree (session-only)
  let ghConfig = JSON.parse(lsGet(LS_GH) || 'null') || { token:'', user:'', repo:'', path:'notes-data.json' };

  // Auto-sync state
  let autoSyncTimer   = null;   // 5-second debounce timer
  let syncBarTimer    = null;   // progress bar animation
  let syncBarProgress = 0;
  let isSyncing       = false;
  const AUTO_SYNC_DELAY = 5000; // 5 seconds

  /* ── Boot: load from localStorage, then auto-pull from GitHub ── */
  async function bootstrap() {
    const stored = lsGet(LS_NOTES);
    if (stored) {
      try { notes = JSON.parse(stored); } catch { notes = getDefaultNotes(); }
    } else {
      notes = getDefaultNotes();
    }
    try { folders = JSON.parse(lsGet(LS_FOLDERS) || '[]'); } catch { folders = []; }
    sanitizeFolders();
    try {
      const t = JSON.parse(lsGet(LS_TABS) || 'null');
      openTabIds = Array.isArray(t?.openTabIds) ? t.openTabIds : [];
      activeId = t?.activeId ?? null;
    } catch { openTabIds = []; activeId = null; }

    // Validate tabs/active note against loaded notes (falls back to first note, like before)
    openTabIds = openTabIds.filter(id => notes.some(n => n.id === id));
    if (!notes.find(n => n.id === activeId)) activeId = openTabIds[0] ?? (notes[0]?.id || null);
    if (activeId && !openTabIds.includes(activeId)) openTabIds.push(activeId);
    if (!openTabIds.length && notes.length) { openTabIds = [notes[0].id]; activeId = notes[0].id; }

    renderAll();
    updateStatus();

    // Auto-pull on open if GitHub is configured
    if (ghIsConfigured()) {
      setSyncStatus('syncing', 'Pulling from GitHub…');
      try {
        await ghPullSilent();
        setSyncStatus('ok', 'Pulled on open');
        setTimeout(() => updateSyncStatusIdle(), 3000);
      } catch(e) {
        setSyncStatus('err', `Pull failed`);
        setTimeout(() => updateSyncStatusIdle(), 4000);
      }
    }
  }

  function getDefaultNotes() {
    return [
      { id:1, title:'Welcome to My Notes',
        body: textToHtml('Your notes app — full screen, auto GitHub sync.\n\n── What\'s new ──\n\n✅ Data stored as JSON (notes-data.json in your repo)\n✅ Full screen on PC/laptop\n✅ Auto-pulls from GitHub when app opens\n✅ Auto-pushes to GitHub every 5 seconds while editing\n✅ Folders to group similar notes\n✅ Tabs to work on several notes at once\n✅ Rich text: bold/italic/underline, font size, color, highlight, alignment\n\nJust set up GitHub (⚙ GitHub button) and everything syncs automatically!'),
        tag:'personal', folderId:'', updated: Date.now()-60000 },
      { id:2, title:'Ideas for the weekend',
        body: textToHtml('Go for a long walk.\nTry that new coffee place.\nFinish the book on the shelf.'),
        tag:'ideas', folderId:'', updated: Date.now()-300000 },
    ];
  }

  const persist = () => {
    lsSet(LS_NOTES, JSON.stringify(notes));
    isDirty = true;
    updateStatus();
  };
  const persistFolders = () => lsSet(LS_FOLDERS, JSON.stringify(folders));
  const persistTabs = () => lsSet(LS_TABS, JSON.stringify({ openTabIds, activeId }));

  /* Reconcile activeId/openTabIds/folderFilter after notes+folders are replaced wholesale (pull/load) */
  function reconcileAfterLoad() {
    sanitizeFolders();
    activeId = notes.find(n=>n.id===activeId) ? activeId : (notes[0]?.id || null);
    openTabIds = openTabIds.filter(id => notes.some(n=>n.id===id));
    if (!openTabIds.length && activeId) openTabIds = [activeId];
    if (activeId && !openTabIds.includes(activeId)) openTabIds.push(activeId);
    if (folderFilter && !folders.some(f=>f.id===folderFilter)) folderFilter = '';
    lsSet(LS_NOTES, JSON.stringify(notes));
    lsSet(LS_FOLDERS, JSON.stringify(folders));
    persistTabs();
  }

  const ghIsConfigured = () => !!(ghConfig.token && ghConfig.user && ghConfig.repo && ghConfig.path);

  function updateStatus() {
    const el = document.getElementById('file-status');
    el.textContent = isDirty
      ? `Unsaved${loadedFrom ? ' · '+loadedFrom : ''}`
      : loadedFrom ? loadedFrom : 'Browser memory';
    document.getElementById('gh-push-btn').disabled = !ghIsConfigured();
    document.getElementById('gh-pull-btn').disabled = !ghIsConfigured();
  }

  function updateSyncStatusIdle() {
    if (ghIsConfigured()) {
      setSyncStatus('', `Auto-sync on`);
    } else {
      setSyncStatus('', 'No sync');
    }
  }

  function setSyncStatus(cls, msg) {
    const el = document.getElementById('sync-status');
    el.className = cls ? `${cls}` : '';
    el.textContent = msg;
  }

  const fmt = ts => new Date(ts).toLocaleDateString(undefined, { day:'numeric', month:'short' });

  function showToast(msg, dur=2800) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), dur);
  }

  /* ── Sync progress bar ── */
  function startSyncBar() {
    syncBarProgress = 0;
    const fill = document.getElementById('sync-bar-fill');
    fill.style.width = '0%'; fill.classList.add('active');
    const step = 100 / (AUTO_SYNC_DELAY / 100);
    clearInterval(syncBarTimer);
    syncBarTimer = setInterval(() => {
      syncBarProgress = Math.min(syncBarProgress + step, 95);
      fill.style.width = syncBarProgress + '%';
    }, 100);
  }

  function completeSyncBar(success) {
    clearInterval(syncBarTimer);
    const fill = document.getElementById('sync-bar-fill');
    fill.style.width = '100%';
    fill.style.background = success ? 'var(--green)' : '#A32D2D';
    setTimeout(() => {
      fill.style.width = '0%';
      fill.classList.remove('active');
      fill.style.background = 'var(--accent)';
    }, 600);
  }

  /* ══════════════════════════════════════════
     GITHUB API
  ══════════════════════════════════════════ */
  function ghHeaders() {
    return { 'Authorization': `token ${ghConfig.token}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' };
  }
  function ghFileUrl() {
    return `https://api.github.com/repos/${ghConfig.user}/${ghConfig.repo}/contents/${ghConfig.path}`;
  }

  /* Push notes → GitHub (returns true/false) */
  async function ghPushCore() {
    const content = btoa(unescape(encodeURIComponent(notesToJSON(notes, folders))));
    let sha = null;
    try {
      const c = await fetch(ghFileUrl(), { headers: ghHeaders() });
      if (c.ok) { const d = await c.json(); sha = d.sha; }
    } catch {}
    const body = { message: `Auto-sync ${new Date().toLocaleString()}`, content };
    if (sha) body.sha = sha;
    const res = await fetch(ghFileUrl(), { method:'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
    if (!res.ok) { const e = await res.json(); throw new Error(e.message || `HTTP ${res.status}`); }
    return true;
  }

  /* Pull notes ← GitHub (returns true/false) */
  async function ghPullCore() {
    const res = await fetch(ghFileUrl(), { headers: ghHeaders() });
    if (!res.ok) { const e = await res.json(); throw new Error(e.message || `HTTP ${res.status}`); }
    const data = await res.json();
    const text = decodeURIComponent(escape(atob(data.content)));
    const { notes: loadedNotes, folders: loadedFolders } = jsonToData(text);
    if (!loadedNotes.length) throw new Error('No notes found in GitHub file.');
    notes = loadedNotes.map(n => ({ ...n, body: normalizeBody(n.body) }));
    folders = loadedFolders;
    isDirty = false;
    loadedFrom = `GitHub (${ghConfig.user}/${ghConfig.repo})`;
    reconcileAfterLoad();
    return true;
  }

  /* Silent pull (used on boot) */
  async function ghPullSilent() {
    await ghPullCore();
    renderAll(); updateStatus();
  }

  /* Manual push button */
  async function ghPush() {
    if (isSyncing) return;
    isSyncing = true;
    const btn = document.getElementById('gh-push-btn');
    btn.disabled = true; btn.textContent = '⬆ Pushing…';
    setSyncStatus('syncing', 'Pushing…');
    try {
      await ghPushCore();
      isDirty = false; loadedFrom = `GitHub (${ghConfig.user}/${ghConfig.repo})`;
      updateStatus(); setSyncStatus('ok', 'Pushed');
      showToast(`✅ Pushed to ${ghConfig.user}/${ghConfig.repo}`);
      setTimeout(updateSyncStatusIdle, 3000);
    } catch(e) {
      setSyncStatus('err', 'Push failed');
      showToast(`❌ Push failed: ${e.message}`, 4000);
      setTimeout(updateSyncStatusIdle, 4000);
    } finally {
      isSyncing = false; btn.disabled = false; btn.textContent = '⬆ Push';
      updateStatus();
    }
  }

  /* Manual pull button */
  async function ghPull() {
    if (isSyncing) return;
    isSyncing = true;
    const btn = document.getElementById('gh-pull-btn');
    btn.disabled = true; btn.textContent = '⬇ Pulling…';
    setSyncStatus('syncing', 'Pulling…');
    try {
      await ghPullCore();
      renderAll(); updateStatus();
      setSyncStatus('ok', `Pulled ${notes.length} notes`);
      showToast(`✅ Pulled ${notes.length} notes from GitHub`);
      setTimeout(updateSyncStatusIdle, 3000);
    } catch(e) {
      setSyncStatus('err', 'Pull failed');
      showToast(`❌ Pull failed: ${e.message}`, 4000);
      setTimeout(updateSyncStatusIdle, 4000);
    } finally {
      isSyncing = false; btn.disabled = false; btn.textContent = '⬇ Pull';
      updateStatus();
    }
  }

  /* Auto-sync: triggered every time a note is edited */
  function scheduleAutoSync() {
    if (!ghIsConfigured()) return;
    clearTimeout(autoSyncTimer);
    startSyncBar();
    setSyncStatus('syncing', `Syncing in 5s…`);
    autoSyncTimer = setTimeout(async () => {
      if (isSyncing) return;
      isSyncing = true;
      setSyncStatus('syncing', 'Auto-pushing…');
      try {
        await ghPushCore();
        isDirty = false; loadedFrom = `GitHub (${ghConfig.user}/${ghConfig.repo})`;
        updateStatus();
        completeSyncBar(true);
        setSyncStatus('ok', 'Auto-synced');
        setTimeout(updateSyncStatusIdle, 2500);
      } catch(e) {
        completeSyncBar(false);
        setSyncStatus('err', 'Sync failed');
        setTimeout(updateSyncStatusIdle, 3000);
      } finally {
        isSyncing = false;
      }
    }, AUTO_SYNC_DELAY);
  }

  /* ── GitHub test connection ── */
  async function ghTest() {
    const token = document.getElementById('gh-token').value.trim();
    const user  = document.getElementById('gh-user').value.trim();
    const repo  = document.getElementById('gh-repo').value.trim();
    const st    = document.getElementById('gh-conn-status');
    if (!token || !user || !repo) { st.className='err'; st.textContent='Fill in all fields first.'; return; }
    st.className=''; st.textContent='Testing…';
    try {
      const res = await fetch(`https://api.github.com/repos/${user}/${repo}`,
        { headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' } });
      if (res.ok) {
        const d = await res.json();
        st.className='ok'; st.textContent=`✅ Connected! "${d.full_name}" (${d.private?'private':'public'})`;
      } else {
        const e = await res.json(); st.className='err'; st.textContent=`❌ ${e.message}`;
      }
    } catch(e) { st.className='err'; st.textContent=`❌ Network error: ${e.message}`; }
  }

  /* ── GitHub modal ── */
  function openGhModal() {
    document.getElementById('gh-token').value = ghConfig.token||'';
    document.getElementById('gh-user').value  = ghConfig.user||'';
    document.getElementById('gh-repo').value  = ghConfig.repo||'';
    document.getElementById('gh-path').value  = ghConfig.path||'notes-data.json';
    document.getElementById('gh-conn-status').textContent = '';
    document.getElementById('gh-modal-wrap').classList.add('open');
  }
  window.openGhModal = openGhModal;
  function closeGhModal() { document.getElementById('gh-modal-wrap').classList.remove('open'); }

  document.getElementById('gh-settings-btn').onclick = openGhModal;
  document.getElementById('gh-cancel-btn').onclick   = closeGhModal;
  document.getElementById('gh-modal-wrap').onclick   = e => { if (e.target === document.getElementById('gh-modal-wrap')) closeGhModal(); };
  document.getElementById('gh-test-btn').onclick     = ghTest;
  document.getElementById('gh-save-btn').onclick     = () => {
    const path = document.getElementById('gh-path').value.trim() || 'notes-data.json';
    ghConfig = {
      token: document.getElementById('gh-token').value.trim(),
      user:  document.getElementById('gh-user').value.trim(),
      repo:  document.getElementById('gh-repo').value.trim(),
      path:  path.endsWith('.json') ? path : path + '.json',
    };
    lsSet(LS_GH, JSON.stringify(ghConfig));
    closeGhModal(); updateStatus(); updateSyncStatusIdle();
    showToast('GitHub settings saved');
  };
  document.getElementById('gh-push-btn').onclick = ghPush;
  document.getElementById('gh-pull-btn').onclick = ghPull;

  /* ══════════════════════════════════════════
     LOCAL FILE SAVE / LOAD (JSON)
  ══════════════════════════════════════════ */
  document.getElementById('save-data-btn').onclick = () => {
    const blob = new Blob([notesToJSON(notes, folders)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'notes-data.json';
    a.click(); URL.revokeObjectURL(a.href);
    isDirty = false; loadedFrom = loadedFrom || 'notes-data.json'; updateStatus();
    showToast('Saved as notes-data.json');
  };

  document.getElementById('load-data-btn').onclick = () => document.getElementById('load-data-input').click();
  document.getElementById('load-data-input').onchange = e => {
    if (e.target.files[0]) loadLocalFile(e.target.files[0]);
    e.target.value = '';
  };

  /* ── Rich text helpers ── */
  function textToHtml(text) {
    return esc(String(text||'')).replace(/\n/g, '<br>');
  }
  function sanitizeHtml(html) {
    return String(html||'')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
      .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
      .replace(/(href|src)\s*=\s*["']\s*javascript:[^"']*["']/gi, '$1="#"');
  }
  function stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = String(html||'').replace(/<\/(div|p|li)>|<br\s*\/?>/gi, ' ');
    return (tmp.textContent || '').replace(/\s+/g,' ').trim();
  }
  /* Accepts either legacy plain-text bodies or new HTML bodies (from any source: old export, GitHub, this app) */
  function normalizeBody(body) {
    if (typeof body !== 'string') return '';
    if (/<[a-z][^>]*>/i.test(body)) return sanitizeHtml(body); // looks like HTML already
    return textToHtml(body); // legacy plain text → HTML with <br> line breaks
  }

  function loadLocalFile(file) {
    const r = new FileReader();
    r.onload = e => {
      try {
        const { notes: loadedNotes, folders: loadedFolders } = jsonToData(e.target.result);
        if (!loadedNotes.length) throw new Error('No notes found in file.');
        notes = loadedNotes.map(n => ({ ...n, body: normalizeBody(n.body) }));
        folders = loadedFolders;
        loadedFrom = file.name; isDirty = false;
        reconcileAfterLoad();
        renderAll(); updateStatus();
        showToast(`Loaded ${notes.length} notes from "${file.name}"`);
      } catch(err) { alert('Could not load file.\n\n' + err.message); }
    };
    r.readAsText(file);
  }

  /* ── Import plain text files as notes ── */
  function titleFromFilename(name) {
    return name.replace(/\.[^.]+$/, '').replace(/[-_]/g,' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  function processTextFile(file) {
    return new Promise(res => {
      const r = new FileReader();
      r.onload = e => {
        let body = e.target.result;
        if (file.name.endsWith('.json')) { try { body = JSON.stringify(JSON.parse(body),null,2); } catch {} }
        res({ id: Date.now()+Math.random(), title: titleFromFilename(file.name),
              body: textToHtml(body.trimEnd()), tag: '', updated: file.lastModified||Date.now(),
              imported: true, sourceFile: file.name });
      };
      r.onerror = () => res(null);
      r.readAsText(file);
    });
  }
  async function importTextFiles(files) {
    const imported = (await Promise.all(Array.from(files).map(processTextFile))).filter(Boolean);
    if (!imported.length) return;
    imported.forEach(n => { n.folderId = folderFilter || ''; notes.unshift(n); openTabIds.push(n.id); });
    activeId = imported[0].id;
    persist(); persistTabs(); renderAll();
    showToast(imported.length === 1 ? `"${imported[0].title}" imported` : `${imported.length} files imported`);
  }
  document.getElementById('import-txt-btn').onclick = () => document.getElementById('import-txt-input').click();
  document.getElementById('import-txt-input').onchange = e => { importTextFiles(e.target.files); e.target.value=''; };

  /* ── Drag & drop ── */
  const overlay = document.getElementById('drop-overlay');
  const dropLabel = document.getElementById('drop-label');
  let dc = 0;
  document.addEventListener('dragenter', e => {
    e.preventDefault(); dc++;
    const files = e.dataTransfer?.items ? Array.from(e.dataTransfer.items) : [];
    const isJson = files.some(i => { const n=i.getAsFile?.()?.name||''; return n.endsWith('.json'); });
    dropLabel.textContent = isJson ? 'Drop to restore notes' : 'Drop file to import as note';
    overlay.classList.add('visible');
  });
  document.addEventListener('dragleave', () => { dc--; if (dc<=0){dc=0;overlay.classList.remove('visible');} });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault(); dc=0; overlay.classList.remove('visible');
    const all = Array.from(e.dataTransfer.files);
    // JSON files that look like our format → load as data
    // Everything else → import as note
    const jsonFiles = all.filter(f => f.name.endsWith('.json'));
    const txtFiles  = all.filter(f => !f.name.endsWith('.json'));
    if (jsonFiles.length) loadLocalFile(jsonFiles[0]);
    if (txtFiles.length)  importTextFiles(txtFiles);
  });

  /* ══════════════════════════════════════════
     RENDER
  ══════════════════════════════════════════ */
  function getFiltered() {
    const q = document.getElementById('search').value.toLowerCase();
    return notes.filter(n => {
      const mt = !filterTag || n.tag === filterTag;
      const mf = !folderFilter || n.folderId === folderFilter;
      const mq = !q || n.title.toLowerCase().includes(q) || stripHtml(n.body).toLowerCase().includes(q);
      return mt && mf && mq;
    }).sort((a,b) => b.updated - a.updated);
  }

  function renderTags() {
    const wrap = document.getElementById('tag-list');
    const used = new Set(notes.map(n=>n.tag).filter(Boolean));
    wrap.innerHTML = '';
    const ab = document.createElement('button');
    ab.className = 'tag-btn' + (!filterTag ? ' active' : '');
    ab.textContent = 'All';
    ab.onclick = () => { filterTag=''; renderAll(); };
    wrap.appendChild(ab);
    ['work','personal','ideas','todo'].filter(t=>used.has(t)).forEach(t => {
      const b = document.createElement('button');
      b.className = 'tag-btn' + (filterTag===t?' active':'');
      b.textContent = t[0].toUpperCase()+t.slice(1);
      b.onclick = () => { filterTag = filterTag===t?'':t; renderAll(); };
      wrap.appendChild(b);
    });
  }

  function renderFolders() {
    const wrap = document.getElementById('folder-list');
    wrap.innerHTML = '';

    const allRow = document.createElement('div');
    allRow.className = 'folder-row all-row' + (!folderFilter ? ' active' : '');
    allRow.innerHTML = `<span class="folder-toggle"></span><span class="folder-label">📁 All notes</span>`;
    allRow.onclick = () => { folderFilter=''; renderAll(); };
    wrap.appendChild(allRow);

    const tree = buildFolderTree();
    const renderLevel = (parentId, depth) => {
      (tree[parentId||''] || []).forEach(f => {
        const hasKids = !!(tree[f.id] && tree[f.id].length);
        const isOpen  = expandedFolders.has(f.id);
        const row = document.createElement('div');
        row.className = 'folder-row' + (folderFilter===f.id ? ' active' : '');
        row.style.paddingLeft = (6 + depth*14) + 'px';
        row.innerHTML = `
          <span class="folder-toggle">${hasKids ? (isOpen?'▾':'▸') : ''}</span>
          <span class="folder-label">📁 ${esc(f.name)}</span>
          <span class="folder-actions">
            <span class="folder-add-sub" title="Add subfolder">+</span>
            <span class="folder-del" title="Delete folder">×</span>
          </span>`;
        row.onclick = (e) => {
          if (e.target.classList.contains('folder-add-sub')) { e.stopPropagation(); newFolder(f.id); return; }
          if (e.target.classList.contains('folder-del'))     { e.stopPropagation(); deleteFolder(f.id); return; }
          if (e.target.classList.contains('folder-toggle') && hasKids) { e.stopPropagation(); toggleFolder(f.id); return; }
          folderFilter = folderFilter===f.id ? '' : f.id; renderAll();
        };
        row.ondblclick = (e) => { e.stopPropagation(); renameFolder(f.id); };
        wrap.appendChild(row);
        if (hasKids && isOpen) renderLevel(f.id, depth+1);
      });
    };
    renderLevel('', 0);

    const addBtn = document.createElement('button');
    addBtn.className = 'folder-add-root';
    addBtn.textContent = '+ Folder';
    addBtn.onclick = () => newFolder();
    wrap.appendChild(addBtn);

    // keep the editor's folder <select> in sync with the folder tree (indented)
    const sel = document.getElementById('folder-select');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">No folder</option>' +
        flattenFoldersForSelect().map(f => `<option value="${f.id}">${'—'.repeat(f.depth)} ${esc(f.name)}</option>`).join('');
      sel.value = cur;
    }
  }

  /* ── Folder tree helpers ── */
  function buildFolderTree() {
    const byParent = {};
    folders.forEach(f => {
      const p = f.parentId || '';
      (byParent[p] = byParent[p] || []).push(f);
    });
    Object.values(byParent).forEach(arr => arr.sort((a,b) => a.name.localeCompare(b.name)));
    return byParent;
  }
  function flattenFoldersForSelect() {
    const tree = buildFolderTree();
    const out = [];
    (function walk(parentId, depth) {
      (tree[parentId||''] || []).forEach(f => { out.push({ id:f.id, name:f.name, depth }); walk(f.id, depth+1); });
    })('', 0);
    return out;
  }
  function folderDescendantIds(id) {
    const tree = buildFolderTree();
    const out = [id];
    (tree[id] || []).forEach(f => out.push(...folderDescendantIds(f.id)));
    return out;
  }
  function folderPath(id) {
    const path = [];
    let cur = folders.find(f => f.id === id);
    while (cur) { path.unshift(cur.name); cur = cur.parentId ? folders.find(f => f.id === cur.parentId) : null; }
    return path.join(' / ');
  }
  function toggleFolder(id) {
    if (expandedFolders.has(id)) expandedFolders.delete(id); else expandedFolders.add(id);
    renderFolders();
  }
  /* Fix parentId references that are missing or would create a cycle (defensive, e.g. after a bad import) */
  function sanitizeFolders() {
    const ids = new Set(folders.map(f=>f.id));
    folders.forEach(f => { if (f.parentId && !ids.has(f.parentId)) f.parentId = ''; });
    folders.forEach(f => {
      const seen = new Set(); let cur = f;
      while (cur && cur.parentId) {
        if (cur.parentId === f.id || seen.has(cur.parentId)) { f.parentId = ''; break; }
        seen.add(cur.parentId);
        cur = folders.find(x => x.id === cur.parentId);
      }
    });
  }

  function newFolder(parentId) {
    const name = prompt(parentId ? 'Subfolder name:' : 'Folder name:');
    if (!name || !name.trim()) return;
    const f = { id: 'f' + Date.now(), name: name.trim(), parentId: parentId || '' };
    folders.push(f);
    if (parentId) expandedFolders.add(parentId);
    persistFolders(); renderFolders();
    scheduleAutoSync();
    showToast(`Folder "${f.name}" created`);
  }

  function renameFolder(id) {
    const f = folders.find(x => x.id === id);
    if (!f) return;
    const name = prompt('Rename folder:', f.name);
    if (!name || !name.trim()) return;
    f.name = name.trim();
    persistFolders(); renderAll();
    scheduleAutoSync();
  }

  function deleteFolder(id) {
    const f = folders.find(x => x.id === id);
    if (!f) return;
    const toDelete = folderDescendantIds(id); // this folder + all nested subfolders
    const msg = toDelete.length > 1
      ? `Delete folder "${f.name}" and its ${toDelete.length-1} subfolder(s)? Notes inside will become unfiled, not deleted.`
      : `Delete folder "${f.name}"? Notes inside will become unfiled, not deleted.`;
    if (!confirm(msg)) return;
    folders = folders.filter(x => !toDelete.includes(x.id));
    notes.forEach(n => { if (toDelete.includes(n.folderId)) n.folderId = ''; });
    if (toDelete.includes(folderFilter)) folderFilter = '';
    toDelete.forEach(fid => expandedFolders.delete(fid));
    persist(); persistFolders(); renderAll();
    scheduleAutoSync();
  }

  function renderList() {
    const list = document.getElementById('note-list');
    const filtered = getFiltered();
    const countEl = document.getElementById('note-count');
    const newCountText = filtered.length + ' note' + (filtered.length!==1?'s':'');
    if (countEl.textContent !== newCountText && countEl.textContent !== '') {
      countEl.classList.remove('bump'); void countEl.offsetWidth; countEl.classList.add('bump');
    }
    countEl.textContent = newCountText;
    if (!filtered.length) { list.innerHTML='<div class="no-notes">No notes found</div>'; return; }
    list.innerHTML = '';
    filtered.forEach((n, idx) => {
      const div = document.createElement('div');
      div.className = 'note-item' + (n.id===activeId?' active':'');
      div.style.animationDelay = Math.min(idx*18, 220) + 'ms';
      div.onclick = () => openTab(n.id);
      const preview = stripHtml(n.body).slice(0,60);
      const tc = n.tag ? TAG_COLORS[n.tag] : null;
      const fname = n.folderId ? folderPath(n.folderId) : '';
      div.innerHTML = `
        <div class="note-item-title">${esc(n.title||'Untitled')}</div>
        <div class="note-item-preview">${esc(preview||'No content')}</div>
        <div class="note-item-meta">
          ${fname?`<span class="note-folder">📁 ${esc(fname)}</span>`:''}
          ${tc?`<span class="note-tag" style="background:${tc.bg};color:${tc.color}">${n.tag}</span>`:''}
          ${n.imported?`<span class="import-badge">imported</span>`:''}
          <span class="note-date">${fmt(n.updated)}</span>
        </div>`;
      list.appendChild(div);
    });
  }

  /* ── Tabs (work on several notes at once) ── */
  function renderTabs() {
    const bar = document.getElementById('tabs-bar');
    const validIds = openTabIds.filter(id => notes.some(n=>n.id===id));
    if (validIds.length !== openTabIds.length) { openTabIds = validIds; persistTabs(); }
    if (!openTabIds.length) { bar.style.display='none'; bar.innerHTML=''; return; }
    bar.style.display='flex';
    bar.innerHTML = '';
    openTabIds.forEach(id => {
      const n = notes.find(x=>x.id===id);
      if (!n) return;
      const tab = document.createElement('div');
      tab.className = 'note-tab' + (id===activeId ? ' active' : '');
      tab.innerHTML = `<span class="note-tab-title">${esc(n.title||'Untitled')}</span><span class="note-tab-close" title="Close tab">×</span>`;
      tab.onclick = (e) => {
        if (e.target.classList.contains('note-tab-close')) { closeTab(id, e); return; }
        activeId = id; persistTabs(); renderList(); renderTabs(); renderEditor();
      };
      bar.appendChild(tab);
    });
  }

  function openTab(id) {
    if (!openTabIds.includes(id)) openTabIds.push(id);
    activeId = id;
    persistTabs();
    renderList(); renderTabs(); renderEditor();
  }

  function closeTab(id, e) {
    if (e) e.stopPropagation();
    openTabIds = openTabIds.filter(x=>x!==id);
    if (activeId === id) activeId = openTabIds.length ? openTabIds[openTabIds.length-1] : null;
    persistTabs();
    renderList(); renderTabs(); renderEditor();
  }

  function renderEditor() {
    const toolbar = document.getElementById('editor-toolbar');
    const fmtbar  = document.getElementById('format-toolbar');
    const empty   = document.getElementById('empty-state');
    const body    = document.getElementById('body-input');
    const note    = notes.find(n=>n.id===activeId);
    if (!note) {
      toolbar.style.display='none'; fmtbar.style.display='none'; empty.style.display='flex'; body.style.display='none';
      return;
    }
    toolbar.style.display='flex'; fmtbar.style.display='flex'; empty.style.display='none'; body.style.display='block';
    document.getElementById('title-input').value  = note.title;
    document.getElementById('folder-select').value = note.folderId||'';
    document.getElementById('tag-select').value    = note.tag||'';
    body.innerHTML = note.body || '';
    updatePlaceholderState();
    document.getElementById('save-indicator').textContent = note.sourceFile ? `📄 ${note.sourceFile}` : '';
    updateStats();
    [toolbar, fmtbar, body].forEach(el => {
      el.classList.remove('editor-fade'); void el.offsetWidth; el.classList.add('editor-fade');
    });
  }

  function updateStats() {
    const statsEl = document.getElementById('note-stats');
    const note = notes.find(n=>n.id===activeId);
    if (!statsEl || !note) { if (statsEl) statsEl.textContent = ''; return; }
    const text = stripHtml(document.getElementById('body-input').innerHTML || note.body || '').trim();
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const chars = text.length;
    const mins = Math.max(1, Math.round(words / 200));
    statsEl.textContent = `${words} word${words!==1?'s':''} · ${chars} char${chars!==1?'s':''} · ${mins} min read`;
  }

  function renderAll() { renderTags(); renderFolders(); renderList(); renderTabs(); renderEditor(); }
  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  /* ── Note actions ── */
  document.getElementById('new-btn').onclick = () => {
    const n = { id:Date.now(), title:'', body:'', tag:'', folderId: folderFilter||'', updated:Date.now() };
    notes.unshift(n);
    persist();
    openTab(n.id);
    renderTags(); renderFolders();
    setTimeout(()=>document.getElementById('title-input').focus(), 50);
  };

  document.getElementById('delete-btn').onclick = () => {
    if (!activeId || !confirm('Delete this note?')) return;
    const idToDelete = activeId;
    notes = notes.filter(n=>n.id!==idToDelete);
    openTabIds = openTabIds.filter(id=>id!==idToDelete);
    activeId = openTabIds.length ? openTabIds[openTabIds.length-1] : (notes[0]?.id||null);
    if (activeId && !openTabIds.includes(activeId)) openTabIds.push(activeId);
    persist(); persistTabs(); renderAll();
    scheduleAutoSync(); // push deletion to GitHub too
  };

  let localSaveTimer = null;
  function updatePlaceholderState() {
    const body = document.getElementById('body-input');
    const html = body.innerHTML.trim();
    body.classList.toggle('is-empty', html === '' || html === '<br>');
  }
  function onEdit() {
    const note = notes.find(n=>n.id===activeId);
    if (!note) return;
    note.title    = document.getElementById('title-input').value;
    note.body     = document.getElementById('body-input').innerHTML;
    note.folderId = document.getElementById('folder-select').value;
    note.tag      = document.getElementById('tag-select').value;
    note.updated  = Date.now();
    updatePlaceholderState();
    updateStats();

    // Local auto-save (600ms debounce)
    clearTimeout(localSaveTimer);
    localSaveTimer = setTimeout(() => {
      persist(); renderTags(); renderFolders(); renderList(); renderTabs();
      document.getElementById('save-indicator').textContent = '💾 Saved locally';
      setTimeout(() => {
        const n = notes.find(x=>x.id===activeId);
        document.getElementById('save-indicator').textContent = n?.sourceFile ? `📄 ${n.sourceFile}` : '';
      }, 1200);
    }, 600);

    // GitHub auto-sync (5 second debounce)
    scheduleAutoSync();
  }

  document.getElementById('title-input').addEventListener('input', onEdit);
  document.getElementById('body-input').addEventListener('input', onEdit);
  document.getElementById('folder-select').addEventListener('change', onEdit);
  document.getElementById('tag-select').addEventListener('change', onEdit);
  document.getElementById('search').addEventListener('input', renderAll);

  /* ── Rich text toolbar ── */
  const bodyEl = document.getElementById('body-input');
  let savedRange = null;
  function saveSelection() {
    const sel = window.getSelection();
    if (sel.rangeCount && bodyEl.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  }
  function restoreSelection() {
    bodyEl.focus();
    if (savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  }
  function applyCmd(cmd, val) {
    restoreSelection();
    try { document.execCommand(cmd, false, val ?? null); } catch(e) {}
    saveSelection();
    onEdit();
  }
  bodyEl.addEventListener('mouseup', saveSelection);
  bodyEl.addEventListener('keyup', saveSelection);

  /* Insert text/nodes at the cursor via the Selection/Range API directly — more
     predictable across browsers than relying on execCommand's return value. */
  function insertTextAtCursor(text) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && bodyEl.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node); range.setEndAfter(node);
      sel.removeAllRanges(); sel.addRange(range);
      return;
    }
    // No live selection inside the note (e.g. rare focus edge case) — fall back
    try { if (document.execCommand('insertText', false, text)) return; } catch(e) {}
    bodyEl.appendChild(document.createTextNode(text));
  }
  function insertLineBreakAtCursor() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && bodyEl.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const br = document.createElement('br');
      range.insertNode(br);
      // Classic contenteditable quirk: a <br> with nothing after it (i.e. you pressed
      // Enter at the very end of the note) gives the browser nowhere to visually
      // place the caret, so the new line silently doesn't appear. Anchoring a
      // zero-width character right after it fixes this — it's invisible, but gives
      // the caret (and any further typing) somewhere real to land on the new line.
      if (!br.nextSibling) {
        const anchor = document.createTextNode('\u200B');
        br.parentNode.insertBefore(anchor, br.nextSibling);
        range.setStart(anchor, 0); range.setEnd(anchor, 0);
      } else {
        range.setStartAfter(br); range.setEndAfter(br);
      }
      sel.removeAllRanges(); sel.addRange(range);
      return;
    }
    try { if (document.execCommand('insertHTML', false, '<br>')) return; } catch(e) {}
    bodyEl.appendChild(document.createElement('br'));
  }

  // Keep line breaks flat (<br>) instead of nested <div>/<p> blocks, and make the
  // real Tab key type an actual tab character instead of jumping focus away from the note.
  bodyEl.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      insertTextAtCursor('\t');
      onEdit();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      insertLineBreakAtCursor();
      onEdit();
    }
  });

  // Bold / Italic / Underline
  document.querySelectorAll('.fmt-btn[data-cmd]').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault()); // keep selection intact
    btn.addEventListener('click', () => applyCmd(btn.dataset.cmd));
  });

  // Alignment
  document.querySelectorAll('.fmt-btn[data-align]').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => applyCmd(btn.dataset.align));
  });

  // Font size (legacy execCommand scale 1–7; 3 = default/normal).
  // Reads the *current selection's* actual size each click, rather than a global
  // counter, so it correctly bumps whichever text is selected.
  function bumpFontSize(delta) {
    restoreSelection();
    let cur = 3;
    try { const v = document.queryCommandValue('fontSize'); if (v) cur = parseInt(v, 10) || 3; } catch(e) {}
    const next = Math.min(7, Math.max(1, cur + delta));
    try { document.execCommand('fontSize', false, next); } catch(e) {}
    saveSelection();
    onEdit();
  }
  document.getElementById('font-inc').addEventListener('mousedown', e => e.preventDefault());
  document.getElementById('font-dec').addEventListener('mousedown', e => e.preventDefault());
  document.getElementById('font-inc').addEventListener('click', () => bumpFontSize(1));
  document.getElementById('font-dec').addEventListener('click', () => bumpFontSize(-1));

  // Text color
  document.getElementById('text-color-input').addEventListener('input', e => applyCmd('foreColor', e.target.value));

  // Highlight color (hiliteColor with backColor fallback for older Safari)
  document.getElementById('highlight-color-input').addEventListener('input', e => {
    restoreSelection();
    try { document.execCommand('hiliteColor', false, e.target.value); }
    catch { try { document.execCommand('backColor', false, e.target.value); } catch {} }
    saveSelection();
    onEdit();
  });
  document.getElementById('highlight-clear-btn').addEventListener('mousedown', e => e.preventDefault());
  document.getElementById('highlight-clear-btn').addEventListener('click', () => {
    restoreSelection();
    try { document.execCommand('hiliteColor', false, 'transparent'); }
    catch { try { document.execCommand('backColor', false, 'transparent'); } catch {} }
    saveSelection();
    onEdit();
  });

  // Tab-space toolbar button (same behavior as pressing the real Tab key)
  document.getElementById('tab-insert-btn').addEventListener('mousedown', e => e.preventDefault());
  document.getElementById('tab-insert-btn').addEventListener('click', () => {
    restoreSelection();
    insertTextAtCursor('\t');
    saveSelection();
    onEdit();
  });

  window.addEventListener('beforeunload', e => {
    if (isDirty) { e.preventDefault(); e.returnValue=''; }
  });

  // Start
  bootstrap();
  updateSyncStatusIdle();

  /* ── Mobile tab switching ── */
  function isMobile() { return window.innerWidth <= 600; }

  function switchMobileTab(tab) {
    if (!isMobile()) return;
    const sidebar = document.getElementById('sidebar');
    const editor  = document.getElementById('editor');
    const tabNotes  = document.getElementById('tab-notes');
    const tabEditor = document.getElementById('tab-editor');
    if (tab === 'notes') {
      sidebar.classList.remove('hidden-mobile');
      editor.classList.remove('visible-mobile');
      tabNotes.classList.add('active');
      tabEditor.classList.remove('active');
    } else {
      sidebar.classList.add('hidden-mobile');
      editor.classList.add('visible-mobile');
      tabNotes.classList.remove('active');
      tabEditor.classList.add('active');
    }
  }
  window.switchMobileTab = switchMobileTab;

  // Auto-switch to editor when a note is tapped on mobile
  const _origRenderList = renderList;
  document.getElementById('note-list').addEventListener('click', e => {
    if (isMobile() && e.target.closest('.note-item')) {
      setTimeout(() => switchMobileTab('editor'), 50);
    }
  });

  // Auto-switch to editor when New Note is tapped on mobile
  const origNewBtn = document.getElementById('new-btn').onclick;
  document.getElementById('new-btn').onclick = function() {
    if (origNewBtn) origNewBtn.call(this);
    if (isMobile()) setTimeout(() => switchMobileTab('editor'), 80);
  };

  // Initialize mobile layout on load
  if (isMobile()) {
    switchMobileTab('notes');
  }
  window.addEventListener('resize', () => {
    if (!isMobile()) {
      // Reset transforms on desktop
      document.getElementById('sidebar').classList.remove('hidden-mobile');
      document.getElementById('editor').classList.remove('visible-mobile');
    }
  });

  /* ══════════════ Command palette (⌘K / Ctrl+K) ══════════════ */
  const cmdkWrap    = document.getElementById('cmdk-wrap');
  const cmdkInput   = document.getElementById('cmdk-input');
  const cmdkResults = document.getElementById('cmdk-results');
  let cmdkSel = 0;
  let cmdkItems = [];

  function cmdkOpen() {
    cmdkWrap.classList.add('open');
    cmdkInput.value = '';
    cmdkRender('');
    setTimeout(() => cmdkInput.focus(), 30);
  }
  function cmdkClose() { cmdkWrap.classList.remove('open'); }

  function cmdkRender(query) {
    const q = query.trim().toLowerCase();
    const scored = notes.map(n => {
      const title = n.title || 'Untitled';
      const preview = stripHtml(n.body).slice(0, 80);
      if (!q) return { n, title, preview, score: n.updated };
      const hay = (title + ' ' + preview).toLowerCase();
      if (!hay.includes(q)) return null;
      const score = (title.toLowerCase().includes(q) ? 1000 : 0) + n.updated / 1e13;
      return { n, title, preview, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 30);

    cmdkItems = scored;
    cmdkSel = 0;
    if (!scored.length) {
      cmdkResults.innerHTML = `<div class="cmdk-empty">No notes match "${esc(query)}"</div>`;
      return;
    }
    const mark = (text) => {
      if (!q) return esc(text);
      const i = text.toLowerCase().indexOf(q);
      if (i === -1) return esc(text);
      return esc(text.slice(0,i)) + '<mark>' + esc(text.slice(i,i+q.length)) + '</mark>' + esc(text.slice(i+q.length));
    };
    cmdkResults.innerHTML = scored.map((s, i) => `
      <div class="cmdk-item${i===0?' sel':''}" data-idx="${i}">
        <div class="cmdk-item-title">${mark(s.title)}</div>
        <div class="cmdk-item-preview">${mark(s.preview || 'No content')}</div>
      </div>`).join('');
    cmdkResults.querySelectorAll('.cmdk-item').forEach(el => {
      el.addEventListener('click', () => cmdkChoose(+el.dataset.idx));
      el.addEventListener('mousemove', () => cmdkHighlight(+el.dataset.idx));
    });
  }

  function cmdkHighlight(idx) {
    cmdkSel = idx;
    cmdkResults.querySelectorAll('.cmdk-item').forEach((el, i) => el.classList.toggle('sel', i===idx));
    const active = cmdkResults.querySelector('.cmdk-item.sel');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function cmdkChoose(idx) {
    const item = cmdkItems[idx];
    if (!item) return;
    cmdkClose();
    openTab(item.n.id);
    if (isMobile()) setTimeout(() => switchMobileTab('editor'), 50);
  }

  document.getElementById('cmdk-open-btn').addEventListener('click', cmdkOpen);
  document.getElementById('cmdk-close-btn').addEventListener('click', cmdkClose);
  cmdkWrap.addEventListener('click', e => { if (e.target === cmdkWrap) cmdkClose(); });
  cmdkInput.addEventListener('input', () => cmdkRender(cmdkInput.value));
  cmdkInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkHighlight(Math.min(cmdkSel+1, cmdkItems.length-1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkHighlight(Math.max(cmdkSel-1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); cmdkChoose(cmdkSel); }
    else if (e.key === 'Escape') { e.preventDefault(); cmdkClose(); }
  });
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      cmdkWrap.classList.contains('open') ? cmdkClose() : cmdkOpen();
    } else if (e.key === 'Escape' && cmdkWrap.classList.contains('open')) {
      cmdkClose();
    }
  });

  /* ══════════════ Magnetic cursor glow on hover surfaces ══════════════ */
  document.addEventListener('mousemove', e => {
    const el = e.target.closest('.tb-btn, #new-btn, #import-txt-btn, .note-item, .folder-row');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    el.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });

  /* ══════════════ Theme switcher ══════════════ */
  const LS_THEME = 'notes_theme_v1';
  function getAccentRgb()  { return getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '79,216,255'; }
  function getAccent2Rgb() { return getComputedStyle(document.documentElement).getPropertyValue('--accent-2-rgb').trim() || '181,140,255'; }

  function applyTheme(theme, refreshParticles) {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
    document.querySelectorAll('.theme-swatch').forEach(el => {
      el.classList.toggle('active', el.dataset.theme === (theme || ''));
    });
    if (refreshParticles && typeof window.__refreshBgParticles === 'function') {
      window.__refreshBgParticles();
    }
  }

  function initThemeSwitcher() {
    const saved = lsGet(LS_THEME) || '';
    applyTheme(saved, false);

    const wrap  = document.getElementById('theme-wrap');
    const btn   = document.getElementById('theme-btn');
    const panel = document.getElementById('theme-panel');

    btn.addEventListener('click', e => {
      e.stopPropagation();
      panel.classList.toggle('open');
    });
    document.addEventListener('click', e => {
      if (!wrap.contains(e.target)) panel.classList.remove('open');
    });
    panel.querySelectorAll('.theme-swatch').forEach(el => {
      el.addEventListener('click', () => {
        const theme = el.dataset.theme;
        applyTheme(theme, true);
        lsSet(LS_THEME, theme);
        panel.classList.remove('open');
        showToast(`Theme: ${el.querySelector('.theme-swatch-name').textContent}`);
      });
    });
  }
  initThemeSwitcher();

  /* ══════════════ Ambient constellation background ══════════════ */
  (function initBgCanvas() {
    const canvas = document.getElementById('bg-canvas');
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w, h, dpr, particles = [];

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth = window.innerWidth;
      h = canvas.clientHeight = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(70, Math.round((w * h) / 22000));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18,
        r: Math.random() * 1.4 + 0.6,
        hue: Math.random() > 0.5 ? getAccentRgb() : getAccent2Rgb(),
      }));
    }

    function step() {
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
      }
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i], b = particles[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.sqrt(dx*dx + dy*dy);
          if (dist < 120) {
            ctx.strokeStyle = `rgba(${getAccentRgb()},${0.10 * (1 - dist/120)})`;
            ctx.lineWidth = 0.6;
            ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
          }
        }
      }
      for (const p of particles) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(${p.hue},0.55)`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
        ctx.fill();
      }
      if (!reduceMotion) requestAnimationFrame(step);
    }

    window.addEventListener('resize', resize);
    window.__refreshBgParticles = resize;
    resize();
    if (!reduceMotion) requestAnimationFrame(step);
    else step(); // draw a single static frame
  })();

/* ═══════════════════════════════════════════════════════════════
   HAKUNA PRODUCTIVITY UPGRADE — additive compatibility layer
   Preserves existing notes, folders, tabs, themes, import/export and GitHub sync.
═══════════════════════════════════════════════════════════════ */
(function HakunaUpgrade(){
  const U = {
    trash:'hakuna_trash_v1', history:'hakuna_history_v1', prefs:'hakuna_prefs_v1',
    read:'hakuna_read_v1', study:'hakuna_study_v1'
  };
  const get=(k,d)=>{try{return JSON.parse(lsGet(k)||'null')??d}catch{return d}};
  const set=(k,v)=>lsSet(k,JSON.stringify(v));
  let trash=get(U.trash,[]), history=get(U.history,{}), prefs=get(U.prefs,{}), read=get(U.read,{}), study=get(U.study,{seen:0,known:0,unknown:0});
  let deferredInstall=null;
  const note=()=>notes.find(n=>n.id===activeId);
  const text=n=>stripHtml(n?.body||'');
  const uid=()=>Date.now()+Math.floor(Math.random()*10000);
  const safeTitle=n=>(n?.title||'Untitled').trim()||'Untitled';
  const saveAll=()=>{persist();persistTabs();renderAll();};
  function refreshNoteBadges(){
    const n=note(); if(!n)return;
    const p=document.getElementById('pin-btn'), f=document.getElementById('favorite-btn');
    p?.classList.toggle('is-on',!!n.pinned); f?.classList.toggle('is-on',!!n.favorite);
    if(p)p.textContent=n.pinned?'📌 Pinned':'📌 Pin'; if(f)f.textContent=n.favorite?'★ Favorite':'☆ Favorite';
  }
  function renderUpgradeList(){
    document.querySelectorAll('.note-item').forEach(el=>{const id=[...el.parentElement.children].indexOf(el); const arr=getFiltered(); const n=arr[id]; if(!n)return; el.classList.toggle('pinned',!!n.pinned); el.classList.toggle('favorite',!!n.favorite);});
    refreshNoteBadges();
  }
  const oldRenderList=renderList, oldRenderEditor=renderEditor, oldRenderAll=renderAll;
  renderList=function(){oldRenderList();renderUpgradeList();};
  renderEditor=function(){oldRenderEditor();refreshNoteBadges();};
  renderAll=function(){oldRenderAll();renderUpgradeList();};

  function moveToTrash(){
    const n=note(); if(!n)return;
    trash.unshift({...n,deletedAt:Date.now(),originalFolderId:n.folderId||''});
    notes=notes.filter(x=>x.id!==n.id); openTabIds=openTabIds.filter(x=>x!==n.id);
    activeId=openTabIds.at(-1) ?? notes[0]?.id ?? null;
    set(U.trash,trash); persist();persistTabs();renderAll();scheduleAutoSync();showToast('Moved to Trash · Undo available');
  }
  function restoreTrash(id){const i=trash.findIndex(n=>n.id===id);if(i<0)return;const n=trash.splice(i,1)[0];delete n.deletedAt; n.folderId=n.originalFolderId||''; delete n.originalFolderId; notes.unshift(n);openTabIds.push(n.id);activeId=n.id;set(U.trash,trash);persist();persistTabs();renderAll();showToast('Note restored');}
  function permanentlyDelete(id){trash=trash.filter(n=>n.id!==id);set(U.trash,trash);showToast('Permanently deleted');}
  function emptyTrash(){if(!trash.length)return;if(!confirm(`Permanently delete ${trash.length} note(s)?`))return;trash=[];set(U.trash,trash);showToast('Trash emptied');}
  function toggleFlag(field){const n=note();if(!n)return;n[field]=!n[field];n.updated=Date.now();persist();renderAll();scheduleAutoSync();}

  function openWorkspace(title,html){document.getElementById('workspace-title').textContent=title;document.getElementById('workspace-body').innerHTML=html;document.getElementById('workspace-modal').classList.add('open');}
  function closeWorkspace(){document.getElementById('workspace-modal').classList.remove('open');}
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>document.getElementById(b.dataset.close).classList.remove('open')));
  document.querySelectorAll('.enh-modal-wrap').forEach(w=>w.addEventListener('click',e=>{if(e.target===w)w.classList.remove('open')}));

  function openTrash(){
    const rows=trash.map(n=>`<div class="workspace-row trash-note"><div><h3>${esc(safeTitle(n))}</h3><p>Deleted ${new Date(n.deletedAt||Date.now()).toLocaleString()} · ${esc(text(n).slice(0,100))}</p></div><div class="workspace-actions"><button data-restore="${n.id}">Restore</button><button data-hard-delete="${n.id}">Delete</button></div></div>`).join('');
    openWorkspace('Recently Deleted',`<div class="workspace-toolbar"><button id="empty-trash-action">Empty Trash</button></div>${rows||'<div class="empty-upgrade">Trash is empty.</div>'}`);
    document.querySelectorAll('[data-restore]').forEach(b=>b.onclick=()=>{restoreTrash(+b.dataset.restore);openTrash()});
    document.querySelectorAll('[data-hard-delete]').forEach(b=>b.onclick=()=>{permanentlyDelete(+b.dataset.hardDelete);openTrash()});
    document.getElementById('empty-trash-action').onclick=()=>{emptyTrash();openTrash()};
  }
  function openFavorites(){
    const fav=notes.filter(n=>n.favorite||n.pinned).sort((a,b)=>(b.updated||0)-(a.updated||0));
    openWorkspace('Favorites & Pinned',fav.length?`<div class="workspace-list">${fav.map(n=>`<div class="workspace-row"><div><h3>${n.pinned?'📌 ':''}${n.favorite?'⭐ ':''}${esc(safeTitle(n))}</h3><p>${esc(text(n).slice(0,140))}</p></div><div class="workspace-actions"><button data-open="${n.id}">Open</button></div></div>`).join('')}</div>`:'<div class="empty-upgrade">Pin or favorite notes to see them here.</div>');
    document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{openTab(+b.dataset.open);closeWorkspace()});
  }

  function snapshot(n){return {id:n.id,title:n.title,body:n.body,tag:n.tag,folderId:n.folderId,updated:n.updated};}
  function rememberHistory(){
    notes.forEach(n=>{const key=String(n.id), arr=history[key]||[], last=arr.at(-1);const sig=JSON.stringify(snapshot(n));if(!last||last.sig!==sig){arr.push({ts:Date.now(),sig,data:snapshot(n)});if(arr.length>30)arr.shift();history[key]=arr;}});set(U.history,history);
  }
  setInterval(rememberHistory,5000);
  function openHistory(){const n=note();if(!n)return;const arr=(history[String(n.id)]||[]).slice().reverse();
    openWorkspace('Version History',arr.length?`<div class="workspace-list">${arr.map((v,i)=>`<div class="workspace-row"><div><h3>${new Date(v.ts).toLocaleString()}</h3><p>${esc(v.data.title||'Untitled')} · ${stripHtml(v.data.body||'').length} chars</p></div><div class="workspace-actions"><button data-preview-version="${i}">Preview</button><button data-restore-version="${i}">Restore</button></div></div>`).join('')}</div>`:'<div class="empty-upgrade">History will appear after the note changes.</div>');
    const current=arr;
    document.querySelectorAll('[data-preview-version]').forEach(b=>b.onclick=()=>{const v=current[+b.dataset.previewVersion];openWorkspace('Version Preview',`<div class="version-diff"><pre>${esc(stripHtml(n.body))}</pre><pre>${esc(stripHtml(v.data.body))}</pre></div>`)});
    document.querySelectorAll('[data-restore-version]').forEach(b=>b.onclick=()=>{const v=current[+b.dataset.restoreVersion];n.title=v.data.title;n.body=v.data.body;n.tag=v.data.tag;n.folderId=v.data.folderId;n.updated=Date.now();persist();renderAll();closeWorkspace();showToast('Version restored')});
  }

  function parseAdvanced(q){const filters={};let rest=q;const rx=/(tag|folder|is|created|updated):([^\s]+)/gi;rest=rest.replace(rx,(_,k,v)=>{filters[k.toLowerCase()]=v;return ''}).trim().toLowerCase();return {filters,rest};}
  const baseGetFiltered=getFiltered;
  getFiltered=function(){const raw=document.getElementById('search')?.value?.trim()||'';if(!raw)return baseGetFiltered();const {filters,rest}=parseAdvanced(raw);let arr=notes.slice();if(filters.tag)arr=arr.filter(n=>(n.tag||'').toLowerCase()===filters.tag);if(filters.is==='pinned')arr=arr.filter(n=>n.pinned);if(filters.is==='favorite')arr=arr.filter(n=>n.favorite);if(filters.is==='todo')arr=arr.filter(n=>/\[ \]|☐|todo/i.test(text(n)));if(filters.folder)arr=arr.filter(n=>folderPath(n.folderId||'').toLowerCase().includes(filters.folder));if(filters.updated==='today'){const d=new Date();d.setHours(0,0,0,0);arr=arr.filter(n=>(n.updated||0)>=d.getTime())}if(filters.created==='today'){const d=new Date();d.setHours(0,0,0,0);arr=arr.filter(n=>(n.created||n.updated||0)>=d.getTime())}if(rest)arr=arr.filter(n=>`${n.title} ${text(n)} ${n.tag||''}`.toLowerCase().includes(rest));if(folderFilter)arr=arr.filter(n=>n.folderId===folderFilter||folderDescendantIds(folderFilter).includes(n.folderId));if(filterTag)arr=arr.filter(n=>n.tag===filterTag);return arr;};

  function openGraph(){
    const nodes=notes.slice(0,80), w=820,h=430,cx=w/2,cy=h/2,r=Math.min(175,Math.max(80,nodes.length*6));
    const pos=new Map();nodes.forEach((n,i)=>{const a=(i/Math.max(nodes.length,1))*Math.PI*2;pos.set(n.id,{x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r})});
    let html='<div class="graph-wrap">';
    const links=[];nodes.forEach(n=>{const body=text(n).toLowerCase();nodes.forEach(m=>{if(n.id<m.id && (body.includes(safeTitle(m).toLowerCase())||body.includes(`[[${safeTitle(m).toLowerCase()}]]`))){links.push([n.id,m.id]);}});});
    links.forEach(([a,b])=>{const A=pos.get(a),B=pos.get(b);const dx=B.x-A.x,dy=B.y-A.y,len=Math.hypot(dx,dy),ang=Math.atan2(dy,dx)*180/Math.PI;html+=`<div class="graph-edge" style="left:${A.x}px;top:${A.y}px;width:${len}px;transform:rotate(${ang}deg)"></div>`});
    nodes.forEach(n=>{const P=pos.get(n.id);html+=`<div class="graph-node" style="left:${P.x}px;top:${P.y}px" data-open-graph="${n.id}">${esc(safeTitle(n))}</div>`});html+='</div>';
    openWorkspace('Knowledge Graph',html);document.querySelectorAll('[data-open-graph]').forEach(b=>b.onclick=()=>{openTab(+b.dataset.openGraph);closeWorkspace()});
  }

  function relatedNotes(n){const words=new Set(text(n).toLowerCase().split(/\W+/).filter(x=>x.length>4));return notes.filter(x=>x.id!==n.id).map(x=>{const w=new Set(text(x).toLowerCase().split(/\W+/));let s=0;for(const k of words)if(w.has(k))s++;return {x,s}}).filter(x=>x.s).sort((a,b)=>b.s-a.s).slice(0,8).map(x=>x.x)}
  function aiLocal(action){const n=note();if(!n)return;const body=text(n);let out='';if(action==='summary'){const s=body.split(/(?<=[.!?])\s+/).filter(Boolean);out=s.slice(0,5).join(' ')+(s.length>5?'\n\n…':'' )}else if(action==='questions'){const topics=(body.match(/\b(Java|Selenium|Playwright|RestAssured|API|SQL|TestNG|Maven|Jenkins|CI\/CD|Docker|Git)\b/gi)||[]);const uniq=[...new Set(topics.map(x=>x.toLowerCase()))];out=['What is the main purpose of this topic?','What are the key concepts and common pitfalls?','How would you explain this in an interview?','Give a real-world example.','How would you test or automate it?'].concat(uniq.map(x=>`What is ${x} and where have you used it?`)).map((q,i)=>`${i+1}. ${q}`).join('\n')}else if(action==='flashcards'){const s=body.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0,12);out=s.map((x,i)=>`Card ${i+1}\nQ: What should you remember from this statement?\nA: ${x}`).join('\n\n')}else if(action==='todos'){const lines=body.split(/\n+/).filter(x=>/\b(todo|task|should|need to|must|fix|learn|complete|practice)\b/i.test(x));out=lines.length?lines.map(x=>'☐ '+x.replace(/^[-*☐☑]\s*/, '')).join('\n'):'No obvious TODOs found. Try writing "TODO:" or "Need to".'}else if(action==='rewrite'){n.body=textToHtml(body.replace(/\n{3,}/g,'\n\n').trim());persist();renderEditor();out='Cleaned extra whitespace and normalized the note body locally.'}else if(action==='links'){const rs=relatedNotes(n);out=rs.length?rs.map(x=>`• ${safeTitle(x)}`).join('\n'):'No strongly related notes found.'}return out;}
  function openAi(){const n=note();if(!n){showToast('Open a note first');return}document.getElementById('ai-output').textContent='Choose an action…';document.getElementById('ai-modal').classList.add('open')}
  document.querySelectorAll('[data-ai]').forEach(b=>b.onclick=()=>document.getElementById('ai-output').textContent=aiLocal(b.dataset.ai));

  function openStudy(){
    const cards=[];notes.forEach(n=>{const body=text(n);const s=body.split(/(?<=[.!?])\s+/).filter(x=>x.length>30).slice(0,4);s.forEach(x=>cards.push({q:`Explain this from “${safeTitle(n)}”: ${x.slice(0,90)}…`,a:x,n:n.id}))});
    if(!cards.length){openWorkspace('Study Mode','<div class="empty-upgrade">Add a few substantial notes first.</div>');return}
    let idx=0;const render=()=>{const c=cards[idx%cards.length];document.getElementById('workspace-title').textContent='Study Mode';document.getElementById('workspace-body').innerHTML=`<div class="study-card"><div class="note-badge">Card ${(idx%cards.length)+1} / ${cards.length}</div><h3>${esc(c.q)}</h3><button id="show-study-answer">Show answer</button><div id="study-answer" class="study-answer">${esc(c.a)}</div><div class="study-buttons"><button id="study-unknown">✗ Need practice</button><button id="study-known">✓ Knew it</button><button id="study-next">Next →</button></div></div>`;document.getElementById('show-study-answer').onclick=()=>document.getElementById('study-answer').classList.toggle('show');document.getElementById('study-next').onclick=()=>{idx++;render()};document.getElementById('study-known').onclick=()=>{study.known++;set(U.study,study);idx++;render()};document.getElementById('study-unknown').onclick=()=>{study.unknown++;set(U.study,study);idx++;render()};};openWorkspace('Study Mode','');render();
  }

  function backupAll(){const payload={version:4,exported:new Date().toISOString(),notes,folders,trash,history,prefs};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`hakuna-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);showToast('Full Hakuna backup exported')}
  function importBackup(file){const r=new FileReader();r.onload=e=>{try{const d=JSON.parse(e.target.result);if(!Array.isArray(d.notes))throw Error('Not a Hakuna backup');notes=d.notes.map(n=>({...n,body:normalizeBody(n.body)}));folders=Array.isArray(d.folders)?d.folders:[];trash=Array.isArray(d.trash)?d.trash:[];history=d.history||{};set(U.trash,trash);set(U.history,history);persist();reconcileAfterLoad();renderAll();showToast('Full backup restored')}catch(err){alert('Backup restore failed: '+err.message)}};r.readAsText(file)}

  document.getElementById('delete-btn').onclick=moveToTrash;
  document.getElementById('pin-btn')?.addEventListener('click',()=>toggleFlag('pinned'));
  document.getElementById('favorite-btn')?.addEventListener('click',()=>toggleFlag('favorite'));
  document.getElementById('history-btn')?.addEventListener('click',openHistory);
  document.getElementById('trash-btn')?.addEventListener('click',openTrash);
  document.getElementById('favorites-btn')?.addEventListener('click',openFavorites);
  document.getElementById('graph-btn')?.addEventListener('click',openGraph);
  document.getElementById('study-btn')?.addEventListener('click',openStudy);
  document.getElementById('backup-btn')?.addEventListener('click',backupAll);
  document.getElementById('workspace-kicker').textContent='Hakuna Workspace';
  // AI entry point: double-click the note stats, keeping the existing toolbar uncluttered.
  document.getElementById('note-stats')?.addEventListener('dblclick',openAi);
  // Add AI command to command palette without changing the existing palette implementation.
  const aiHint=document.createElement('button');aiHint.textContent='✨ AI';aiHint.className='fmt-btn';aiHint.title='AI & Study Assistant';aiHint.onclick=openAi;document.getElementById('format-toolbar')?.appendChild(aiHint);

  // Search hint and keyboard help.
  const search=document.getElementById('search');if(search)search.title='Supports: tag:work folder:interview is:pinned is:favorite updated:today';
  window.addEventListener('keydown',e=>{
    const mod=e.ctrlKey||e.metaKey;
    if(mod&&e.key.toLowerCase()==='n'){e.preventDefault();document.getElementById('new-btn').click()}
    if(mod&&e.shiftKey&&e.key.toLowerCase()==='p'){e.preventDefault();toggleFlag('pinned')}
    if(mod&&e.shiftKey&&e.key.toLowerCase()==='f'){e.preventDefault();toggleFlag('favorite')}
    if(mod&&e.shiftKey&&e.key.toLowerCase()==='s'){e.preventDefault();openStudy()}
    if(e.key==='F1'){e.preventDefault();document.getElementById('command-help').classList.add('open')}
    if(e.key==='Escape'){document.querySelectorAll('.enh-modal-wrap.open').forEach(x=>x.classList.remove('open'))}
  });

  // Track last-opened time and keep note history bounded.
  if(activeId) {read[String(activeId)]=Date.now();set(U.read,read)}
  // PWA install support.
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;const b=document.getElementById('install-banner');if(b)b.hidden=false});
  document.getElementById('install-btn')?.addEventListener('click',async()=>{if(!deferredInstall)return;deferredInstall.prompt();deferredInstall=null;document.getElementById('install-banner').hidden=true});
  document.getElementById('install-dismiss')?.addEventListener('click',()=>document.getElementById('install-banner').hidden=true);
  if('serviceWorker' in navigator && location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(()=>{});

  // Make pinned/favorite notes appear first without changing the original filtering semantics.
  const originalFilteredSort = renderList;
  // Initial upgrade state.
  setTimeout(()=>{rememberHistory();renderUpgradeList()},100);
})();

/* Editor extensions: checklist, code block, markdown conversion, images, backlinks and export helpers. */
(function EditorUpgrade(){
  const body=()=>document.getElementById('body-input');
  const current=()=>notes.find(n=>n.id===activeId);
  const htmlEscape=s=>esc(String(s||''));
  function insertHtmlAtCursor(html){const b=body();b.focus();document.execCommand('insertHTML',false,html);b.dispatchEvent(new Event('input',{bubbles:true}));}
  document.getElementById('checklist-btn')?.addEventListener('mousedown',e=>e.preventDefault());
  document.getElementById('checklist-btn')?.addEventListener('click',()=>insertHtmlAtCursor('<div class="hakuna-check"><input type="checkbox"> <span>Task</span></div>'));
  document.getElementById('code-block-btn')?.addEventListener('mousedown',e=>e.preventDefault());
  document.getElementById('code-block-btn')?.addEventListener('click',()=>insertHtmlAtCursor('<pre><code>// code here</code></pre>'));
  function mdToHtml(md){
    let x=htmlEscape(md).replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/^# (.*)$/gm,'<h1>$1</h1>');
    x=x.replace(/^[-*] (.*)$/gm,'<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g,m=>'<ul>'+m+'</ul>');
    x=x.replace(/^\d+\. (.*)$/gm,'<li>$1</li>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    return x.split(/\n{2,}/).map(p=>/^<(h\d|ul|ol)/.test(p.trim())?p:'<p>'+p.replace(/\n/g,'<br>')+'</p>').join('');
  }
  document.getElementById('markdown-btn')?.addEventListener('click',()=>{const n=current();if(!n)return;const raw=text(n);n.body=mdToHtml(raw);n.updated=Date.now();persist();renderEditor();showToast('Markdown converted to rich text')});
  body()?.addEventListener('paste',e=>{const items=e.clipboardData?.items||[];for(const item of items){if(item.type.startsWith('image/')){e.preventDefault();const f=item.getAsFile();const r=new FileReader();r.onload=ev=>insertHtmlAtCursor(`<img src="${ev.target.result}" alt="Pasted image" style="max-width:100%;height:auto;border-radius:10px">`);r.readAsDataURL(f);break;}}});
  body()?.addEventListener('click',e=>{const a=e.target.closest('a');if(a&&a.getAttribute('href')?.startsWith('[[')){e.preventDefault();const title=a.getAttribute('href').slice(2,-2);const n=notes.find(x=>safeTitle(x).toLowerCase()===title.toLowerCase());if(n)openTab(n.id)}});
  window.exportActiveMarkdown=function(){const n=current();if(!n)return;const md=`# ${safeTitle(n)}\n\n${text(n)}`;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([md],{type:'text/markdown'}));a.download=(safeTitle(n).replace(/[^a-z0-9]+/gi,'-')||'note')+'.md';a.click();URL.revokeObjectURL(a.href)};
  window.printActiveNote=function(){const n=current();if(!n)return;const w=window.open('','_blank','width=900,height=700');w.document.write(`<html><head><title>${htmlEscape(safeTitle(n))}</title><style>body{font:16px system-ui;max-width:800px;margin:40px auto;line-height:1.7}img{max-width:100%}pre{background:#f4f4f4;padding:12px}</style></head><body><h1>${htmlEscape(safeTitle(n))}</h1>${sanitizeHtml(n.body)}</body></html>`);w.document.close();w.focus();setTimeout(()=>w.print(),300)};
  // Restore helper input for complete backups.
  const input=document.createElement('input');input.type='file';input.accept='.json';input.hidden=true;input.id='hakuna-backup-input';document.body.appendChild(input);input.onchange=e=>{if(e.target.files[0])importBackup(e.target.files[0]);e.target.value=''};
  const oldBackup=document.getElementById('backup-btn');oldBackup?.addEventListener('contextmenu',e=>{e.preventDefault();input.click()});
  // Add export buttons to workspace when backup is opened through a normal click.
  const backupBtn=document.getElementById('backup-btn');backupBtn?.addEventListener('dblclick',()=>input.click());
  // Add lightweight backlinks section below the editor after each render.
  function backlinks(){const n=current();if(!n)return;let el=document.getElementById('hakuna-backlinks');if(!el){el=document.createElement('div');el.id='hakuna-backlinks';document.getElementById('editor').appendChild(el)}const refs=notes.filter(x=>x.id!==n.id&&text(x).toLowerCase().includes(safeTitle(n).toLowerCase())).slice(0,10);el.innerHTML=refs.length?`<span>↗ Linked from</span> ${refs.map(x=>`<button data-backlink="${x.id}">${esc(safeTitle(x))}</button>`).join('')}`:'<span>↗ No backlinks yet</span>';el.querySelectorAll('[data-backlink]').forEach(b=>b.onclick=()=>openTab(+b.dataset.backlink))}
  const oldEditor=renderEditor;renderEditor=function(){oldEditor();backlinks();};
})();
