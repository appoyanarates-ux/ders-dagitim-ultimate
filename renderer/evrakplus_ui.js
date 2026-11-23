'use strict';

(function (root) {
  const SYNC_STATUS_LABELS = {
    disabled: { text: 'Kapalı (Yerel)', cls: 'bg-slate-100 text-slate-600' },
    synced:   { text: 'Güncel', cls: 'bg-emerald-100 text-emerald-800' },
    saving:   { text: 'Kaydediliyor...', cls: 'bg-indigo-100 text-indigo-800' },
    offline:  { text: 'İnternet bağlantısı yok', cls: 'bg-amber-100 text-amber-800' },
    pending:  { text: 'Bekleyen değişiklikler var', cls: 'bg-amber-100 text-amber-800' },
    conflict: { text: 'Senkronizasyon çakışması', cls: 'bg-rose-100 text-rose-800' },
    error:    { text: 'Hata oluştu', cls: 'bg-rose-100 text-rose-800' }
  };

  let appHooks = null;
  let currentSession = {
    loggedIn: false,
    baseUrl: 'https://www.evrakplus.com',
    registerUrl: 'https://www.evrakplus.com/wp-login.php?action=register',
    accountUrl: 'https://www.evrakplus.com/hesabim/',
    user: null,
    entitlement: { exportAllowed: false, status: 'unauthenticated', offlineValid: false, offlineExpired: false, offlineRemainingDays: 0 }
  };
  let pendingLogin = null; // { deviceCode, userCode, verificationUrl, timerId }
  let pendingPostLoginCallback = null;
  let activeConflict = null;

  function el(id) { return document.getElementById(id); }

  function showModal(id) {
    const m = el(id);
    if (!m) return;
    m.classList.remove('hidden');
    m.classList.add('flex');
  }

  function hideModal(id) {
    const m = el(id);
    if (!m) return;
    m.classList.add('hidden');
    m.classList.remove('flex');
  }

  function setSyncBadge(statusKey) {
    const badge = el('m7CloudSyncStatusBadge');
    if (!badge) return;
    const info = SYNC_STATUS_LABELS[statusKey] || SYNC_STATUS_LABELS.disabled;
    badge.textContent = info.text;
    badge.className = `text-[11px] font-semibold px-2.5 py-1 rounded-full ${info.cls}`;
  }

  function ensureProjectMeta(state) {
    if (!state.cloudMeta || typeof state.cloudMeta !== 'object') {
      state.cloudMeta = {
        projectUuid: 'prj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10),
        version: 0,
        cloudSyncEnabled: false,
        lastSyncedAt: null,
        syncStatus: 'disabled'
      };
    }
    if (!state.cloudMeta.projectUuid) {
      state.cloudMeta.projectUuid = 'prj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }
    return state.cloudMeta;
  }

  function syncSessionIntoState() {
    if (!appHooks) return;
    const st = appHooks.getState();
    if (!st) return;
    st.evrakPlusSession = currentSession;
    const meta = ensureProjectMeta(st);
    const chk = el('chkM7CloudSyncOptIn');
    if (chk) chk.checked = Boolean(meta.cloudSyncEnabled);
    setSyncBadge(meta.cloudSyncEnabled ? (meta.syncStatus || 'pending') : 'disabled');
  }

  function renderSidebarAuth() {
    const outBox = el('sidebarAuthLoggedOut');
    const inBox = el('sidebarAuthLoggedIn');
    if (!outBox || !inBox) return;

    if (currentSession && currentSession.loggedIn && currentSession.user) {
      outBox.classList.add('hidden');
      inBox.classList.remove('hidden');
      const nameEl = el('sidebarUserFullName');
      const statusEl = el('sidebarUserStatus');
      const badgeEl = el('sidebarOfflineBadge');
      if (nameEl) nameEl.textContent = currentSession.user.full_name || currentSession.user.email || 'EvrakPlus Üyesi';
      if (statusEl) statusEl.textContent = currentSession.user.membership_label || 'Ücretsiz EvrakPlus Üyesi';
      if (badgeEl) {
        const ent = currentSession.entitlement || {};
        if (ent.exportAllowed) {
          badgeEl.textContent = `${ent.offlineRemainingDays || 7}g`;
          badgeEl.title = `Çevrimdışı çıktı yetkisi: ${ent.offlineRemainingDays || 7} gün`;
          badgeEl.className = 'shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-semibold';
        } else {
          badgeEl.textContent = 'Yenile';
          badgeEl.title = 'Çevrimdışı çıktı yetkisinin süresi dolmuş';
          badgeEl.className = 'shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-semibold';
        }
      }
    } else {
      outBox.classList.remove('hidden');
      inBox.classList.add('hidden');
    }
    syncSessionIntoState();
  }

  async function openExternalUrl(url) {
    const api = window.dersDagitimAPI;
    if (api && typeof api.evrakplusOpenUrl === 'function') {
      try {
        await api.evrakplusOpenUrl(url);
        return;
      } catch (err) {
        if (appHooks) appHooks.showToast(err.message || 'Bağlantı açılamadı.');
        return;
      }
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function stopLoginPolling() {
    if (pendingLogin && pendingLogin.timerId) {
      clearInterval(pendingLogin.timerId);
    }
    pendingLogin = null;
    const idleBox = el('epLoginIdleBox');
    const pendBox = el('epLoginPendingBox');
    const errBox = el('epLoginErrorBox');
    if (idleBox) idleBox.classList.remove('hidden');
    if (pendBox) pendBox.classList.add('hidden');
    if (errBox) { errBox.classList.add('hidden'); errBox.textContent = ''; }
  }

  function openGateModal(message, onSuccessCallback) {
    pendingPostLoginCallback = typeof onSuccessCallback === 'function' ? onSuccessCallback : null;
    const msgEl = el('evrakplusGateMessage');
    if (msgEl) {
      msgEl.textContent = message || window.DersExportEngine.EvrakPlusAuthService.GATE_MESSAGE;
    }
    showModal('evrakplusGateModal');
  }

  function openLoginModal() {
    hideModal('evrakplusGateModal');
    stopLoginPolling();
    showModal('evrakplusLoginModal');
  }

  async function startDeviceLoginFlow() {
    const api = window.dersDagitimAPI;
    const errBox = el('epLoginErrorBox');
    if (errBox) { errBox.classList.add('hidden'); errBox.textContent = ''; }

    if (!api || typeof api.evrakplusStartLogin !== 'function') {
      if (errBox) {
        errBox.textContent = 'Masaüstü EvrakPlus köprüsü algılanamadı. Web sürümünde tarayıcı oturumunuz kullanılır.';
        errBox.classList.remove('hidden');
      }
      return;
    }

    try {
      const res = await api.evrakplusStartLogin({ openBrowser: true });
      const idleBox = el('epLoginIdleBox');
      const pendBox = el('epLoginPendingBox');
      const codeEl = el('epUserCodeDisplay');
      const statusEl = el('epLoginPollStatus');
      if (idleBox) idleBox.classList.add('hidden');
      if (pendBox) pendBox.classList.remove('hidden');
      if (codeEl) codeEl.textContent = res.userCode || '—';
      if (statusEl) statusEl.textContent = 'Tarayıcıda onay bekleniyor...';

      const intervalMs = Math.max(2500, (res.interval || 3) * 1000);
      const timerId = setInterval(async () => {
        if (!pendingLogin) return;
        try {
          const poll = await api.evrakplusPollLogin(res.deviceCode);
          if (poll.status === 'pending') return;
          if (poll.status === 'approved' && poll.session) {
            stopLoginPolling();
            currentSession = poll.session;
            renderSidebarAuth();
            hideModal('evrakplusLoginModal');
            if (appHooks) appHooks.showToast(`Hoş geldiniz, ${currentSession.user.full_name}!`);
            if (pendingPostLoginCallback) {
              const cb = pendingPostLoginCallback;
              pendingPostLoginCallback = null;
              cb();
            }
          } else {
            stopLoginPolling();
            if (errBox) {
              errBox.textContent = poll.message || 'Cihaz eşleştirme tamamlanamadı.';
              errBox.classList.remove('hidden');
            }
          }
        } catch (pollErr) {
          if (statusEl) statusEl.textContent = pollErr.message || 'Bağlantı bekleniyor...';
        }
      }, intervalMs);

      pendingLogin = {
        deviceCode: res.deviceCode,
        userCode: res.userCode,
        verificationUrl: res.verificationUrl,
        timerId
      };
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || 'EvrakPlus sunucusuna bağlanılamadı.';
        errBox.classList.remove('hidden');
      }
    }
  }

  async function refreshSessionOnStartup() {
    const api = window.dersDagitimAPI;
    if (!api || typeof api.evrakplusGetSession !== 'function') {
      // Tarayıcı/PWA önizlemesi: yerel geliştirme durumunda oturum kapalı başlar
      renderSidebarAuth();
      return;
    }
    try {
      currentSession = await api.evrakplusGetSession();
      renderSidebarAuth();
      // Çevrimiçiyse arka planda 7 günlük çıktı yetkisini sessizce tazele
      if (currentSession.loggedIn && navigator.onLine !== false) {
        try {
          currentSession = await api.evrakplusRefreshEntitlements();
          renderSidebarAuth();
        } catch (_offlineErr) {
          // Çevrimdışıysa yerel imzalı 7 günlük yetki korunur
        }
      }
    } catch (_err) {
      renderSidebarAuth();
    }
  }

  async function handleLogout() {
    const api = window.dersDagitimAPI;
    if (api && typeof api.evrakplusLogout === 'function') {
      const res = await api.evrakplusLogout();
      currentSession = res.session || { loggedIn: false, user: null, entitlement: { exportAllowed: false } };
    } else {
      currentSession = { loggedIn: false, user: null, entitlement: { exportAllowed: false } };
    }
    renderSidebarAuth();
    if (appHooks) appHooks.showToast('EvrakPlus oturumu kapatıldı.');
  }

  function buildSerializablePayload(st) {
    const clone = JSON.parse(JSON.stringify(st));
    delete clone.evrakPlusSession;
    return clone;
  }

  function backupSnapshotToLocalArchive(title, snapshot) {
    if (!appHooks || typeof appHooks.saveToLocalArchive !== 'function') return;
    appHooks.saveToLocalArchive(title, snapshot);
  }

  async function syncCurrentProjectToCloud({ force = false, asNewProject = false } = {}) {
    if (!currentSession || !currentSession.loggedIn) {
      openGateModal('Bulut senkronizasyonu için ücretsiz EvrakPlus hesabınızla giriş yapın.', () => {
        syncCurrentProjectToCloud({ force, asNewProject });
      });
      return;
    }
    const api = window.dersDagitimAPI;
    if (!api || typeof api.evrakplusSyncProject !== 'function') {
      if (appHooks) appHooks.showToast('Bulut senkronizasyonu için masaüstü bağlantısı gerekli.');
      return;
    }

    const st = appHooks.getState();
    const meta = ensureProjectMeta(st);
    if (!meta.cloudSyncEnabled) {
      meta.cloudSyncEnabled = true;
      const chk = el('chkM7CloudSyncOptIn');
      if (chk) chk.checked = true;
    }
    if (asNewProject) {
      meta.projectUuid = 'prj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      meta.version = 0;
    }

    setSyncBadge('saving');
    try {
      const titleInput = el('m7ProjectTitle');
      const title = (titleInput && titleInput.value.trim()) || st.school.name || 'Ders Programı Projesi';
      const res = await api.evrakplusSyncProject({
        projectUuid: meta.projectUuid,
        baseVersion: meta.version || 0,
        title,
        schoolName: st.school.name || '',
        academicYear: st.school.academicYear || '2026-2027',
        schoolType: st.school.schoolTypeId || '',
        payload: buildSerializablePayload(st),
        force
      });

      if (res.status === 'conflict') {
        meta.syncStatus = 'conflict';
        setSyncBadge('conflict');
        // Veri kaybını önlemek için HER İKİ sürümü yerel arşive yedekle!
        backupSnapshotToLocalArchive(`[Çakışma Yedeği - Yerel] ${title}`, buildSerializablePayload(st));
        if (res.serverProject && res.serverProject.payload) {
          backupSnapshotToLocalArchive(`[Çakışma Yedeği - Bulut v${res.serverVersion}] ${title}`, res.serverProject.payload);
        }
        activeConflict = {
          localTitle: title,
          serverVersion: res.serverVersion,
          serverProject: res.serverProject
        };
        const desc = el('epConflictDesc');
        if (desc) {
          desc.textContent = `Bulut sürümü (v${res.serverVersion}) yerel sürümünüzden (v${meta.version}) farklı. Güvenliğiniz için hem yerel hem bulut kopyası yerel proje arşivine yedeklendi.`;
        }
        showModal('evrakplusConflictModal');
        return;
      }

      meta.version = res.version;
      meta.lastSyncedAt = res.updatedAt || new Date().toISOString();
      meta.syncStatus = 'synced';
      appHooks.saveState();
      setSyncBadge('synced');
      if (appHooks) appHooks.showToast(`Buluta kaydedildi (v${res.version})`);
    } catch (err) {
      const isOffline = err.code === 'NETWORK_OFFLINE' || navigator.onLine === false;
      meta.syncStatus = isOffline ? 'offline' : 'error';
      setSyncBadge(meta.syncStatus);
      if (appHooks) appHooks.showToast(err.message || 'Bulut senkronizasyonu başarısız.');
    }
  }

  async function openCloudProjectsModal() {
    if (!currentSession || !currentSession.loggedIn) {
      openGateModal('Bulut projelerinizi görüntülemek için EvrakPlus hesabınızla giriş yapın.', () => {
        openCloudProjectsModal();
      });
      return;
    }
    showModal('evrakplusCloudModal');
    await refreshCloudProjectsList();
  }

  async function refreshCloudProjectsList() {
    const listEl = el('epCloudProjectsList');
    const statusEl = el('epCloudListStatus');
    const api = window.dersDagitimAPI;
    if (!listEl || !api || typeof api.evrakplusListProjects !== 'function') return;

    if (statusEl) statusEl.textContent = 'Bulut projeleri yükleniyor...';
    listEl.innerHTML = '';

    try {
      const projects = await api.evrakplusListProjects();
      if (statusEl) statusEl.textContent = `Toplam ${projects.length} bulut projesi`;
      if (!projects.length) {
        listEl.innerHTML = '<div class="rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">Henüz buluta kaydedilmiş ders programı projeniz yok.</div>';
        return;
      }
      projects.forEach((p) => {
        const card = document.createElement('div');
        card.className = 'rounded-xl border border-slate-200 p-3.5 flex flex-wrap items-center justify-between gap-2 hover:border-indigo-300 transition';
        const kb = Math.max(1, Math.round((Number(p.payload_size) || 0) / 1024));
        card.innerHTML = `
          <div class="min-w-0">
            <div class="text-xs font-bold text-slate-900 truncate"></div>
            <div class="text-[11px] text-slate-500">v${Number(p.version) || 1} · ${kb} KB · ${p.updated_at || ''}</div>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" data-open-uuid="${p.project_uuid}" class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold">Aç</button>
            <button type="button" data-del-uuid="${p.project_uuid}" class="px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 text-[11px] font-semibold">Sil</button>
          </div>
        `;
        card.querySelector('.font-bold').textContent = p.title || p.school_name || 'Ders Programı';
        listEl.appendChild(card);
      });

      listEl.querySelectorAll('[data-open-uuid]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const uuid = btn.getAttribute('data-open-uuid');
          try {
            const full = await api.evrakplusGetProject(uuid);
            if (full && full.payload) {
              const loaded = full.payload;
              loaded.cloudMeta = {
                projectUuid: full.project_uuid,
                version: Number(full.version) || 1,
                cloudSyncEnabled: true,
                lastSyncedAt: full.updated_at,
                syncStatus: 'synced'
              };
              appHooks.loadExternalState(loaded);
              hideModal('evrakplusCloudModal');
              appHooks.showToast(`Bulut projesi açıldı: ${full.title}`);
            }
          } catch (err) {
            appHooks.showToast(err.message || 'Bulut projesi açılamadı.');
          }
        });
      });

      listEl.querySelectorAll('[data-del-uuid]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const uuid = btn.getAttribute('data-del-uuid');
          if (!window.confirm('Bu bulut projesini silmek istediğinize emin misiniz?')) return;
          try {
            await api.evrakplusDeleteProject(uuid);
            await refreshCloudProjectsList();
            appHooks.showToast('Bulut projesi silindi.');
          } catch (err) {
            appHooks.showToast(err.message || 'Proje silinemedi.');
          }
        });
      });
    } catch (err) {
      if (statusEl) statusEl.textContent = err.message || 'Bulut projeleri alınamadı.';
    }
  }

  function registerPwaServiceWorker() {
    if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  function bindUiEvents() {
    const on = (id, ev, fn) => { const node = el(id); if (node) node.addEventListener(ev, fn); };

    on('btnSidebarLogin', 'click', () => openLoginModal());
    on('btnSidebarRegister', 'click', () => openExternalUrl(currentSession.registerUrl));
    on('btnSidebarAccount', 'click', () => openExternalUrl(currentSession.accountUrl));
    on('btnSidebarCloudProjects', 'click', () => openCloudProjectsModal());
    on('btnSidebarLogout', 'click', () => handleLogout());

    on('btnCloseGateModal', 'click', () => hideModal('evrakplusGateModal'));
    on('btnGateLogin', 'click', () => openLoginModal());
    on('btnGateRegister', 'click', () => {
      hideModal('evrakplusGateModal');
      openExternalUrl(currentSession.registerUrl);
    });

    on('btnCloseLoginModal', 'click', () => { stopLoginPolling(); hideModal('evrakplusLoginModal'); });
    on('btnStartDeviceLogin', 'click', () => startDeviceLoginFlow());
    on('btnOpenEvrakPlusRegister', 'click', () => openExternalUrl(currentSession.registerUrl));
    on('btnReopenVerifyUrl', 'click', () => {
      if (pendingLogin && pendingLogin.verificationUrl) openExternalUrl(pendingLogin.verificationUrl);
    });
    on('btnCancelDeviceLogin', 'click', () => stopLoginPolling());

    on('btnCloseCloudModal', 'click', () => hideModal('evrakplusCloudModal'));
    on('btnCloudRefreshList', 'click', () => refreshCloudProjectsList());
    on('btnCloudSaveCurrentNow', 'click', async () => {
      await syncCurrentProjectToCloud({ force: false });
      await refreshCloudProjectsList();
    });

    on('chkM7CloudSyncOptIn', 'change', (e) => {
      const st = appHooks.getState();
      const meta = ensureProjectMeta(st);
      meta.cloudSyncEnabled = Boolean(e.target.checked);
      meta.syncStatus = meta.cloudSyncEnabled ? 'pending' : 'disabled';
      appHooks.saveState();
      setSyncBadge(meta.syncStatus);
    });
    on('btnM7SaveToCloud', 'click', () => syncCurrentProjectToCloud({ force: false }));
    on('btnM7OpenCloudModal', 'click', () => openCloudProjectsModal());

    on('btnCloseConflictModal', 'click', () => hideModal('evrakplusConflictModal'));
    on('btnConflictKeepLocal', 'click', async () => {
      hideModal('evrakplusConflictModal');
      await syncCurrentProjectToCloud({ force: true });
    });
    on('btnConflictOpenCloud', 'click', () => {
      hideModal('evrakplusConflictModal');
      if (activeConflict && activeConflict.serverProject && activeConflict.serverProject.payload) {
        const loaded = activeConflict.serverProject.payload;
        loaded.cloudMeta = {
          projectUuid: activeConflict.serverProject.project_uuid,
          version: Number(activeConflict.serverVersion) || 1,
          cloudSyncEnabled: true,
          lastSyncedAt: activeConflict.serverProject.updated_at,
          syncStatus: 'synced'
        };
        appHooks.loadExternalState(loaded);
        appHooks.showToast('Bulut sürümü açıldı (yerel çalışmanız arşive yedeklendi).');
      }
      activeConflict = null;
    });
    on('btnConflictKeepBoth', 'click', async () => {
      hideModal('evrakplusConflictModal');
      await syncCurrentProjectToCloud({ force: false, asNewProject: true });
      activeConflict = null;
    });

    window.addEventListener('online', () => {
      if (currentSession.loggedIn) refreshSessionOnStartup();
    });
    window.addEventListener('offline', () => {
      const st = appHooks && appHooks.getState();
      if (st && st.cloudMeta && st.cloudMeta.cloudSyncEnabled) setSyncBadge('offline');
    });
  }

  root.EvrakPlusUI = {
    init(hooks) {
      appHooks = hooks;
      bindUiEvents();
      refreshSessionOnStartup();
      registerPwaServiceWorker();
    },
    openGateModal,
    openLoginModal,
    openCloudProjectsModal,
    syncCurrentProjectToCloud,
    getSession: () => currentSession,
    refreshSidebar: renderSidebarAuth
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
