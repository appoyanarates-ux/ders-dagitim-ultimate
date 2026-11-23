'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DersExportEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DAY_NAMES = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
  const DAY_SHORT = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

  function escapeHtml(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function sanitizeWindowsFilename(name, fallback = 'cikti') {
    const clean = String(name || fallback)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[._]+|[._]+$/g, '');
    return (clean || fallback).slice(0, 120);
  }

  function sanitizeExcelCell(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'number' || typeof val === 'boolean') return val;
    const str = String(val);
    if (/^[=+\-@\t\r]/.test(str)) {
      return "'" + str;
    }
    return str;
  }

  function createDefaultExportSettings() {
    return {
      principalName: '',
      coordinatorName: '',
      customTitle: '',
      footerText: '',
      showDate: true,
      showSignatures: true,
      showLogo: false,
      logoDataUrl: '',
      pageSize: 'A4',
      orientation: 'landscape',
      fontSize: 'medium',
      fitToPage: true,
      colorMode: 'color',
      teacherDisplay: 'full', // 'full' | 'code' | 'hidden'
      splitA4Sheets: true,
      showTeacherTotals: true,
      evrakPlusEnforcement: 'development_open' // 'development_open' | 'strict_evrakplus'
    };
  }

  /* =========================================================================
     1. EVRAKPLUS YETKİLENDİRME SERVİSİ (AŞAMA 4 + AŞAMA 5)
     ========================================================================= */
  const EVRAKPLUS_GATE_MESSAGE =
    'Bu özellikten yararlanmak için ücretsiz EvrakPlus üyeliğinizle giriş yapmanız gerekiyor. Ders programınızı oluşturmaya ve düzenlemeye ücretsiz devam edebilirsiniz.';

  const EvrakPlusAuthService = {
    GATE_MESSAGE: EVRAKPLUS_GATE_MESSAGE,
    checkExportPermission(action, state) {
      // Aşama 5: Canlı EvrakPlus masaüstü / web oturumu varsa doğrudan sunucu imzalı yetkiyi kontrol et
      if (state && state.evrakPlusSession && typeof state.evrakPlusSession === 'object') {
        const sess = state.evrakPlusSession;
        const ent = sess.entitlement || {};
        if (sess.loggedIn && ent.exportAllowed) {
          return {
            allowed: true,
            mode: 'evrakplus_session',
            status: 'verified',
            action,
            user: sess.user || null,
            expiresAt: ent.expiresAt || null,
            offlineRemainingDays: ent.offlineRemainingDays || 0
          };
        }
        return {
          allowed: false,
          mode: 'evrakplus_session',
          status: ent.offlineExpired ? 'expired_license' : 'auth_required',
          action,
          message: ent.offlineExpired
            ? 'EvrakPlus çevrimdışı çıktı yetkinizin (7 gün) süresi doldu. Lütfen internet bağlantısı ile oturumunuzu yenileyin.'
            : EVRAKPLUS_GATE_MESSAGE
        };
      }

      const settings = (state && state.exportSettings) || {};
      const mode = settings.evrakPlusEnforcement || 'development_open';
      const license = state && state.evrakPlusLicense;

      if (mode === 'development_open') {
        return {
          allowed: true,
          mode: 'development_open',
          status: 'not_configured_dev_mode',
          action,
          message: 'EvrakPlus üyelik API bağlantısı henüz etkinleştirilmedi (geliştirme/test ortamı açık).'
        };
      }

      if (!license || typeof license !== 'object' || !license.token || !license.expiresAt) {
        return {
          allowed: false,
          mode: 'strict_evrakplus',
          status: 'missing_license',
          action,
          message: EVRAKPLUS_GATE_MESSAGE
        };
      }

      const expMs = Date.parse(license.expiresAt);
      if (Number.isNaN(expMs) || expMs <= Date.now()) {
        return {
          allowed: false,
          mode: 'strict_evrakplus',
          status: 'expired_license',
          action,
          message: 'EvrakPlus çevrimdışı çıktı yetki süreniz dolmuş. Lütfen bağlantınızı yenileyin.'
        };
      }

      return {
        allowed: true,
        mode: 'strict_evrakplus',
        status: 'verified',
        action,
        user: license.user || null,
        expiresAt: license.expiresAt
      };
    }
  };

  /* =========================================================================
     2. ÇIKTI ÖNCESİ GEÇERLİLİK VE KALİTE RAPORU HESAPLAYICI (BÖLÜM 10 & 11)
     ========================================================================= */
  function computeTeacherDayMetrics(teacherId, placements, numDays) {
    const dailyHours = Array(numDays).fill(0);
    let workingDays = 0;
    let totalGaps = 0;
    let maxConsecutive = 0;

    for (let d = 0; d < numDays; d++) {
      const occupied = [];
      (placements || []).forEach((pl) => {
        if (pl.day_index === d && (pl.teacher_ids || []).includes(teacherId)) {
          dailyHours[d] += Number(pl.length || 0);
          for (let k = 0; k < pl.length; k++) occupied.push(pl.start_period + k);
        }
      });
      if (occupied.length > 0) {
        workingDays++;
        const uniq = Array.from(new Set(occupied)).sort((a, b) => a - b);
        if (uniq.length >= 2) {
          const minP = uniq[0];
          const maxP = uniq[uniq.length - 1];
          const occSet = new Set(uniq);
          for (let p = minP + 1; p < maxP; p++) {
            if (!occSet.has(p)) totalGaps++;
          }
        }
        let run = 0, prev = -2;
        for (const p of uniq) {
          run = (p === prev + 1) ? run + 1 : 1;
          prev = p;
          if (run > maxConsecutive) maxConsecutive = run;
        }
      }
    }

    return {
      totalHours: dailyHours.reduce((a, b) => a + b, 0),
      dailyHours,
      workingDays,
      totalGaps,
      maxConsecutive
    };
  }

  function computeDetailedReports(state, helpers, editorLogic) {
    const classes = helpers.getCurrentClasses();
    const teachers = helpers.getCurrentTeachers();
    const rooms = helpers.getCurrentRooms();
    const gridStats = helpers.getSlotStats();
    const numDays = gridStats.activeDayIndices.length;
    const periods = state.grid.periodsPerDay;
    const openSlotsPerWeek = gridStats.openTotal || (numDays * periods);
    const placements = (state.solution && Array.isArray(state.solution.placements)) ? state.solution.placements : [];

    const auditIssues = editorLogic ? editorLogic.auditScheduleLocal(state, helpers) : [];
    const errorIssues = auditIssues.filter((i) => i.severity === 'error');

    // 1. Öğretmen Yük Raporu
    const teacherRows = teachers.map((t) => {
      const m = computeTeacherDayMetrics(t.id, placements, numDays);
      return {
        id: t.id,
        name: t.name,
        shortCode: t.shortCode || t.name.slice(0, 3).toUpperCase(),
        branch: t.branch,
        maxWeekly: t.maxHours || 30,
        totalHours: m.totalHours,
        dailyHours: m.dailyHours,
        workingDays: m.workingDays,
        gaps: m.totalGaps,
        maxConsecutive: m.maxConsecutive
      };
    });

    // 2. Sınıf Ders Raporu
    let totalTargetHours = 0;
    let totalPlacedHours = 0;
    const classRows = classes.map((cls) => {
      const courses = cls.courses || [];
      const targetH = courses.reduce((s, c) => s + Number(c.hours || 0), 0);
      const clsPl = placements.filter((p) => p.class_id === cls.id);
      const placedH = clsPl.reduce((s, p) => s + Number(p.length || 0), 0);
      const daily = Array(numDays).fill(0);
      let brokenBlocks = 0;
      clsPl.forEach((p) => {
        if (p.day_index >= 0 && p.day_index < numDays) daily[p.day_index] += Number(p.length || 0);
        if (p.start_period < 0 || p.start_period + p.length > periods) brokenBlocks++;
      });
      totalTargetHours += targetH;
      totalPlacedHours += placedH;
      return {
        id: cls.id,
        name: cls.name,
        gradeKey: cls.gradeKey,
        shift: cls.shift || 'full_day',
        targetHours: targetH,
        placedHours: placedH,
        missingHours: Math.max(0, targetH - placedH),
        dailyHours: daily,
        blockIntegrityOk: brokenBlocks === 0 && placedH === targetH
      };
    });

    // 3. Özel Derslik Raporu
    const roomRows = rooms.map((rm) => {
      const rmPl = placements.filter((p) => p.room_id === rm.id);
      const usedHours = rmPl.reduce((s, p) => s + Number(p.length || 0), 0);
      const cap = Number(rm.capacity || 1);
      const totalCapHours = openSlotsPerWeek * cap;
      const usedCourses = Array.from(new Set(rmPl.map((p) => `${p.class_name} ${p.course_code}`)));

      // Eşzamanlı kullanım ihlali sayısı
      let violations = 0;
      for (let d = 0; d < numDays; d++) {
        const dayPl = rmPl.filter((p) => p.day_index === d);
        for (let p = 0; p < periods; p++) {
          const active = dayPl.filter((x) => p >= x.start_period && p < x.start_period + x.length).length;
          if (active > cap) violations++;
        }
      }
      return {
        id: rm.id,
        name: rm.name,
        roomType: rm.roomType,
        capacity: cap,
        usedHours,
        freeCapacityHours: Math.max(0, totalCapHours - usedHours),
        coursesList: usedCourses,
        violations
      };
    });

    const totalGaps = teacherRows.reduce((s, r) => s + r.gaps, 0);
    const lockedBlocksCount = placements.filter((pl) => {
      if (!editorLogic) return false;
      return editorLogic.isPlacementLocked(pl, state.pinnedPlacementIds, state.lockedTeacherIds).locked;
    }).length;

    const teacherOverlapCount = errorIssues.filter((e) => e.category === 'Öğretmen Çakışması').length;
    const classOverlapCount = errorIssues.filter((e) => e.category === 'Sınıf Çakışması').length;
    const missingHoursTotal = classRows.reduce((s, r) => s + r.missingHours, 0);

    const summary = {
      totalTeachers: teachers.length,
      totalClasses: classes.length,
      totalRooms: rooms.length,
      totalTargetHours,
      totalPlacedHours,
      missingHoursTotal,
      totalGaps,
      lockedBlocksCount,
      violationCount: errorIssues.length,
      teacherOverlapCount,
      classOverlapCount,
      isValid: placements.length > 0 && errorIssues.length === 0 && missingHoursTotal === 0,
      errorIssues,
      dayNames: gridStats.activeDayIndices.map((d) => DAY_NAMES[d]),
      dayShorts: gridStats.activeDayIndices.map((d) => DAY_SHORT[d])
    };

    return { summary, teacherRows, classRows, roomRows };
  }

  function checkScheduleValidityForExport(state, helpers, editorLogic) {
    const rep = computeDetailedReports(state, helpers, editorLogic);
    const s = rep.summary;
    if (s.isValid) {
      return {
        isValid: true,
        isDraft: false,
        validatedAt: new Date().toLocaleString('tr-TR'),
        message: 'Program doğrulandı: çakışma veya eksik ders saati bulunmuyor.',
        report: rep
      };
    }
    const parts = [];
    if (s.teacherOverlapCount > 0) parts.push(`${s.teacherOverlapCount} öğretmen çakışması`);
    if (s.classOverlapCount > 0) parts.push(`${s.classOverlapCount} sınıf çakışması`);
    if (s.missingHoursTotal > 0) parts.push(`${s.missingHoursTotal} eksik ders saati`);
    const otherErrs = s.violationCount - s.teacherOverlapCount - s.classOverlapCount;
    if (otherErrs > 0) parts.push(`${otherErrs} kısıt/uygunluk ihlali`);
    const detail = parts.length ? parts.join(' ve ') : 'eksik/doğrulanmamış yerleşim';

    return {
      isValid: false,
      isDraft: true,
      validatedAt: new Date().toLocaleString('tr-TR'),
      message: `Programda ${detail} bulundu.`,
      report: rep
    };
  }

  /* =========================================================================
     3. PROFESYONEL HTML / PDF ŞABLON ÜRETİCİLERİ (BÖLÜM 2, 3, 4, 5, 6, 8, 12)
     ========================================================================= */
  function getPrintCss(opts = {}) {
    const pageSize = opts.pageSize === 'A3' ? 'A3' : 'A4';
    const orient = opts.orientation === 'portrait' ? 'portrait' : 'landscape';
    const fontMap = { small: '9.5px', medium: '11px', large: '12.5px' };
    const baseFont = fontMap[opts.fontSize] || '11px';
    const isBw = opts.colorMode === 'bw';

    return `
      @page { size: ${pageSize} ${orient}; margin: 10mm; }
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body {
        margin: 0; padding: 0;
        font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Arial, sans-serif;
        font-size: ${baseFont};
        color: #0f172a;
        background: #ffffff;
      }
      .doc-page {
        page-break-after: always;
        break-after: page;
        padding: 4mm 2mm;
        position: relative;
      }
      .doc-page:last-child { page-break-after: auto; break-after: auto; }
      .draft-banner {
        border: 2px dashed ${isBw ? '#000' : '#dc2626'};
        background: ${isBw ? '#f1f5f9' : '#fef2f2'};
        color: ${isBw ? '#000' : '#991b1b'};
        text-align: center;
        font-weight: 800;
        font-size: 13px;
        padding: 5px 10px;
        margin-bottom: 8px;
        letter-spacing: 1px;
      }
      .doc-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 2px solid #1e293b;
        padding-bottom: 6px;
        margin-bottom: 10px;
      }
      .doc-header-center { text-align: center; flex: 1; }
      .doc-school { font-size: 1.35em; font-weight: 800; text-transform: uppercase; letter-spacing: 0.3px; }
      .doc-year { font-size: 0.95em; font-weight: 600; color: #334155; margin-top: 2px; }
      .doc-title { font-size: 1.15em; font-weight: 700; color: ${isBw ? '#000' : '#1e3a8a'}; margin-top: 3px; }
      .doc-meta-bar {
        display: flex; justify-content: space-between; align-items: center;
        font-size: 0.9em; background: ${isBw ? '#f8fafc' : '#eff6ff'};
        border: 1px solid #cbd5e1; border-radius: 4px;
        padding: 5px 10px; margin-bottom: 8px; font-weight: 600;
      }
      table.tt-table {
        width: 100%; border-collapse: collapse; table-layout: fixed;
      }
      table.tt-table th, table.tt-table td {
        border: 1px solid #64748b;
        padding: 4px 5px;
        vertical-align: middle;
        word-wrap: break-word;
        overflow-wrap: break-word;
      }
      table.tt-table thead th {
        background: ${isBw ? '#e2e8f0' : '#1e293b'};
        color: ${isBw ? '#0f172a' : '#ffffff'};
        font-weight: 700;
        text-align: center;
      }
      table.tt-table tbody tr:nth-child(even) { background: #f8fafc; }
      .cell-code { font-weight: 800; font-size: 1em; color: #0f172a; }
      .cell-name { font-weight: 600; font-size: 0.9em; color: #1e293b; line-height: 1.2; }
      .cell-sub { font-size: 0.82em; color: ${isBw ? '#334155' : '#4338ca'}; font-weight: 600; }
      .cell-lock { font-size: 0.75em; font-weight: 700; color: #b45309; }
      .summary-strip {
        margin-top: 8px; display: flex; flex-wrap: wrap; gap: 12px;
        font-size: 0.88em; border: 1px solid #cbd5e1; padding: 6px 10px; border-radius: 4px; background: #f8fafc;
      }
      .sig-block {
        margin-top: 16px; display: flex; justify-content: space-between; padding: 0 24px; font-size: 0.92em;
      }
      .sig-col { text-align: center; min-width: 180px; }
      .sig-role { font-weight: 700; color: #334155; }
      .sig-name { margin-top: 28px; font-weight: 700; border-top: 1px solid #94a3b8; padding-top: 4px; }
      .doc-footer {
        margin-top: 10px; font-size: 0.78em; color: #64748b;
        display: flex; justify-content: space-between; border-top: 1px solid #e2e8f0; padding-top: 4px;
      }
    `;
  }

  function renderHeaderBlock(state, titleText, isDraft) {
    const es = { ...createDefaultExportSettings(), ...(state.exportSettings || {}) };
    const schoolName = (state.school && state.school.name) || 'OKUL DERS DAĞITIM PROGRAMI';
    const year = (state.school && state.school.academicYear) || '2026–2027';
    const dateStr = es.showDate ? new Date().toLocaleDateString('tr-TR') : '';
    const logoHtml = (es.showLogo && es.logoDataUrl)
      ? `<img src="${es.logoDataUrl}" alt="Logo" style="height:48px;width:auto;object-fit:contain;" />`
      : `<div style="width:48px;"></div>`;

    return `
      ${isDraft ? `<div class="draft-banner">TASLAK – DOĞRULANMAMIŞ PROGRAM</div>` : ''}
      <div class="doc-header">
        ${logoHtml}
        <div class="doc-header-center">
          <div class="doc-school">${escapeHtml(schoolName)}</div>
          <div class="doc-year">${escapeHtml(year)} Eğitim Öğretim Yılı</div>
          <div class="doc-title">${escapeHtml(es.customTitle ? `${es.customTitle} — ${titleText}` : titleText)}</div>
        </div>
        <div style="min-width:75px;text-align:right;font-size:0.82em;color:#475569;">${escapeHtml(dateStr)}</div>
      </div>
    `;
  }

  function renderSignatureBlock(state) {
    const es = { ...createDefaultExportSettings(), ...(state.exportSettings || {}) };
    if (!es.showSignatures) return '';
    const coord = (es.coordinatorName || (state.school && state.school.coordinator) || '').trim();
    const principal = (es.principalName || '').trim();

    return `
      <div class="sig-block">
        <div class="sig-col">
          <div class="sig-role">Hazırlayan (Program Sorumlusu)</div>
          <div class="sig-name">${coord ? escapeHtml(coord) : '................................'}</div>
        </div>
        <div class="sig-col">
          <div class="sig-role">Onaylayan (Okul Müdürü)</div>
          <div class="sig-name">${principal ? escapeHtml(principal) : '................................'}</div>
        </div>
      </div>
    `;
  }

  function renderFooterBlock(state, isDraft, pageNum, totalPages) {
    const es = { ...createDefaultExportSettings(), ...(state.exportSettings || {}) };
    const left = es.footerText ? escapeHtml(es.footerText) : (isDraft ? 'TASLAK ÇIKTI' : 'Google OR-Tools CP-SAT ile doğrulanmıştır');
    const right = totalPages ? `Sayfa ${pageNum} / ${totalPages}` : '';
    return `<div class="doc-footer"><span>${left}</span><span>${right}</span></div>`;
  }

  function formatTeacherForCell(teacherIds, tMap, mode) {
    if (mode === 'hidden') return '';
    return (teacherIds || []).map((id) => {
      const t = tMap[id];
      if (!t) return '';
      return mode === 'code' ? (t.shortCode || t.name.slice(0, 3).toUpperCase()) : t.name;
    }).filter(Boolean).join(', ');
  }

  function buildClassTimetablePageHtml(state, cls, helpers, isDraft, pageIdx, totalPages) {
    const es = { ...createDefaultExportSettings(), ...(state.exportSettings || {}) };
    const gridStats = helpers.getSlotStats();
    const bell = helpers.computeBellSchedule ? helpers.computeBellSchedule() : { primary: [], afternoon: null, isDouble: false };
    const isAfternoon = bell.isDouble && cls.shift === 'afternoon' && bell.afternoon;
    const scheduleArr = isAfternoon ? bell.afternoon : bell.primary;
    const shiftLabel = bell.isDouble ? (cls.shift === 'afternoon' ? 'Öğlenci Devresi' : 'Sabahçı Devresi') : 'Tam Gün (Tekli Öğretim)';

    const teachers = helpers.getCurrentTeachers();
    const rooms = helpers.getCurrentRooms();
    const tMap = Object.fromEntries(teachers.map((t) => [t.id, t]));
    const rMap = Object.fromEntries(rooms.map((r) => [r.id, r]));
    const placements = ((state.solution && state.solution.placements) || []).filter((p) => p.class_id === cls.id);

    const cellMap = {};
    let totalHours = 0;
    placements.forEach((pl) => {
      totalHours += Number(pl.length || 0);
      for (let k = 0; k < pl.length; k++) cellMap[`${pl.day_index}_${pl.start_period + k}`] = pl;
    });

    const rowsHtml = Array.from({ length: state.grid.periodsPerDay }, (_, pIdx) => {
      const b = scheduleArr[pIdx] || { period: pIdx + 1, start: '', end: '' };
      const tds = gridStats.activeDayIndices.map((origDay, cIdx) => {
        if (((state.grid.slots[origDay] && state.grid.slots[origDay][pIdx]) || 'ACTIVE') === 'BLOCKED') {
          return `<td style="text-align:center;color:#94a3b8;background:#f1f5f9;">Kapalı</td>`;
        }
        const pl = cellMap[`${cIdx}_${pIdx}`];
        if (!pl) return `<td style="text-align:center;color:#cbd5e1;">—</td>`;
        const tText = formatTeacherForCell(pl.teacher_ids, tMap, es.teacherDisplay);
        const rText = pl.room_id && rMap[pl.room_id] ? rMap[pl.room_id].name : '';
        return `
          <td>
            <div class="cell-code">${escapeHtml(pl.course_code)}</div>
            <div class="cell-name">${escapeHtml(pl.course_name)}</div>
            ${tText ? `<div class="cell-sub">${escapeHtml(tText)}</div>` : ''}
            ${rText ? `<div class="cell-sub">[${escapeHtml(rText)}]</div>` : ''}
          </td>
        `;
      }).join('');
      return `
        <tr>
          <td style="text-align:center;font-weight:700;width:95px;">
            <div>${b.period}. Ders</div>
            <div style="font-size:0.82em;color:#475569;font-weight:500;">${escapeHtml(b.start)}–${escapeHtml(b.end)}</div>
          </td>
          ${tds}
        </tr>
      `;
    }).join('');

    return `
      <div class="doc-page">
        ${renderHeaderBlock(state, `${cls.name} Sınıfı Haftalık Ders Programı`, isDraft)}
        <div class="doc-meta-bar">
          <span>Şube: ${escapeHtml(cls.name)}${cls.homeRoom ? ` (Derslik: ${escapeHtml(cls.homeRoom)})` : ''}</span>
          <span>Öğretim Devresi: ${escapeHtml(shiftLabel)}</span>
          <span>Haftalık Toplam Ders: ${totalHours} Saat</span>
        </div>
        <table class="tt-table">
          <thead>
            <tr>
              <th style="width:95px;">Ders / Saat</th>
              ${gridStats.activeDayIndices.map((d) => `<th>${DAY_NAMES[d]}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${renderSignatureBlock(state)}
        ${renderFooterBlock(state, isDraft, pageIdx, totalPages)}
      </div>
    `;
  }

  function buildTeacherTimetablePageHtml(state, teacher, helpers, isDraft, pageIdx, totalPages) {
    const es = { ...createDefaultExportSettings(), ...(state.exportSettings || {}) };
    const gridStats = helpers.getSlotStats();
    const bell = helpers.computeBellSchedule ? helpers.computeBellSchedule() : { primary: [], afternoon: null, isDouble: false };
    const rooms = helpers.getCurrentRooms();
    const rMap = Object.fromEntries(rooms.map((r) => [r.id, r]));
    const allPl = (state.solution && state.solution.placements) || [];
    const placements = allPl.filter((p) => (p.teacher_ids || []).includes(teacher.id));
    const metrics = computeTeacherDayMetrics(teacher.id, allPl, gridStats.activeDayIndices.length);

    const cellMap = {};
    placements.forEach((pl) => {
      for (let k = 0; k < pl.length; k++) cellMap[`${pl.day_index}_${pl.start_period + k}`] = pl;
    });

    const rowsHtml = Array.from({ length: state.grid.periodsPerDay }, (_, pIdx) => {
      const b = bell.primary[pIdx] || { period: pIdx + 1, start: '', end: '' };
      const tds = gridStats.activeDayIndices.map((origDay, cIdx) => {
        if (((state.grid.slots[origDay] && state.grid.slots[origDay][pIdx]) || 'ACTIVE') === 'BLOCKED') {
          return `<td style="text-align:center;color:#94a3b8;background:#f1f5f9;">Kapalı</td>`;
        }
        const pl = cellMap[`${cIdx}_${pIdx}`];
        if (!pl) {
          const isUnav = teacher.availability && teacher.availability[origDay] && teacher.availability[origDay][pIdx] === 'UNAVAILABLE';
          return `<td style="text-align:center;color:${isUnav ? '#ef4444' : '#cbd5e1'};">${isUnav ? 'Kapalı' : '—'}</td>`;
        }
        const rText = pl.room_id && rMap[pl.room_id] ? rMap[pl.room_id].name : '';
        return `
          <td>
            <div class="cell-code">${escapeHtml(pl.class_name)} — ${escapeHtml(pl.course_code)}</div>
            <div class="cell-name">${escapeHtml(pl.course_name)}</div>
            ${rText ? `<div class="cell-sub">[${escapeHtml(rText)}]</div>` : ''}
          </td>
        `;
      }).join('');
      return `
        <tr>
          <td style="text-align:center;font-weight:700;width:95px;">
            <div>${b.period}. Ders</div>
            <div style="font-size:0.82em;color:#475569;font-weight:500;">${escapeHtml(b.start)}–${escapeHtml(b.end)}</div>
          </td>
          ${tds}
        </tr>
      `;
    }).join('');

    const dailyBreakdown = gridStats.activeDayIndices
      .map((d, idx) => `${DAY_SHORT[d]}: ${metrics.dailyHours[idx]} sa`)
      .join(' · ');

    return `
      <div class="doc-page">
        ${renderHeaderBlock(state, `Öğretmen Haftalık Ders Programı`, isDraft)}
        <div class="doc-meta-bar">
          <span>Öğretmen: ${escapeHtml(teacher.name)}</span>
          <span>Branş: ${escapeHtml(teacher.branch)}</span>
          <span>Haftalık Toplam Ders: ${metrics.totalHours} Saat</span>
        </div>
        <table class="tt-table">
          <thead>
            <tr>
              <th style="width:95px;">Ders / Saat</th>
              ${gridStats.activeDayIndices.map((d) => `<th>${DAY_NAMES[d]}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${es.showTeacherTotals ? `
          <div class="summary-strip">
            <span><strong>Haftalık Toplam:</strong> ${metrics.totalHours} sa</span>
            <span><strong>Ders Verilen Gün:</strong> ${metrics.workingDays} gün</span>
            <span><strong>Haftalık Boş Pencere:</strong> ${metrics.totalGaps}</span>
            <span><strong>Maks. Ardışık Ders:</strong> ${metrics.maxConsecutive} sa</span>
            <span><strong>Günlük Dağılım:</strong> ${escapeHtml(dailyBreakdown)}</span>
          </div>
        ` : ''}
        ${renderSignatureBlock(state)}
        ${renderFooterBlock(state, isDraft, pageIdx, totalPages)}
      </div>
    `;
  }

  function buildCarsafPagesHtml(state, mode, helpers, isDraft, filterOpts = {}) {
    const es = { ...createDefaultExportSettings(), ...(state.exportSettings || {}) };
    const gridStats = helpers.getSlotStats();
    const periods = state.grid.periodsPerDay;
    const placements = (state.solution && state.solution.placements) || [];
    const teachers = helpers.getCurrentTeachers();
    const classes = helpers.getCurrentClasses();
    const tMap = Object.fromEntries(teachers.map((t) => [t.id, t]));

    // A4'te çok sayfalı bölme: A4 seçili ve splitA4Sheets aktifse günleri 2 veya 3'erli sayfalara böl
    const allDays = gridStats.activeDayIndices.map((origDay, cIdx) => ({ origDay, cIdx, name: DAY_NAMES[origDay] }));
    const dayChunks = (es.pageSize === 'A4' && es.splitA4Sheets && allDays.length > 3)
      ? [allDays.slice(0, 3), allDays.slice(3)]
      : [allDays];

    if (mode === 'class_sheet') {
      let targetClasses = [...classes].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
      if (filterOpts.gradeKey && filterOpts.gradeKey !== 'ALL') {
        targetClasses = targetClasses.filter((c) => c.gradeKey === filterOpts.gradeKey);
      }
      if (Array.isArray(filterOpts.selectedIds) && filterOpts.selectedIds.length) {
        targetClasses = targetClasses.filter((c) => filterOpts.selectedIds.includes(c.id));
      }

      const cellMap = {};
      placements.forEach((pl) => {
        if (!cellMap[pl.class_id]) cellMap[pl.class_id] = {};
        for (let k = 0; k < pl.length; k++) cellMap[pl.class_id][`${pl.day_index}_${pl.start_period + k}`] = pl;
      });

      const pages = [];
      dayChunks.forEach((dChunk, chunkIdx) => {
        const dayTitle = dayChunks.length > 1 ? ` (Günler: ${dChunk.map((d) => d.name).join(', ')})` : '';
        const rowsHtml = targetClasses.map((cls) => {
          let totalH = 0;
          placements.filter((p) => p.class_id === cls.id).forEach((p) => { totalH += p.length; });
          const tds = dChunk.map(({ origDay, cIdx }) =>
            Array.from({ length: periods }, (_, p) => {
              if (((state.grid.slots[origDay] && state.grid.slots[origDay][p]) || 'ACTIVE') === 'BLOCKED') return `<td style="text-align:center;color:#94a3b8;background:#f1f5f9;">—</td>`;
              const pl = cellMap[cls.id] && cellMap[cls.id][`${cIdx}_${p}`];
              if (!pl) return `<td style="text-align:center;color:#cbd5e1;">·</td>`;
              const tCode = formatTeacherForCell(pl.teacher_ids, tMap, es.teacherDisplay === 'hidden' ? 'hidden' : 'code');
              return `<td style="text-align:center;padding:2px;"><div style="font-weight:800;font-size:0.88em;">${escapeHtml(pl.course_code)}</div>${tCode ? `<div style="font-size:0.75em;color:#4338ca;">${escapeHtml(tCode)}</div>` : ''}</td>`;
            }).join('')
          ).join('');
          return `<tr><td style="font-weight:800;">${escapeHtml(cls.name)}</td>${tds}<td style="text-align:center;font-weight:800;">${totalH}</td></tr>`;
        }).join('');

        pages.push(`
          <div class="doc-page">
            ${renderHeaderBlock(state, `Sınıf Çarşaf Programı${dayTitle}`, isDraft)}
            <table class="tt-table">
              <thead>
                <tr>
                  <th rowspan="2" style="width:64px;">Şube</th>
                  ${dChunk.map((d) => `<th colspan="${periods}">${d.name}</th>`).join('')}
                  <th rowspan="2" style="width:42px;">Top.</th>
                </tr>
                <tr>
                  ${dChunk.map(() => Array.from({ length: periods }, (_, p) => `<th>${p + 1}</th>`).join('')).join('')}
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
            ${renderFooterBlock(state, isDraft, chunkIdx + 1, dayChunks.length)}
          </div>
        `);
      });
      return pages.join('');
    }

    // Öğretmen Çarşaf Programı
    let targetTeachers = [...teachers];
    if (filterOpts.branch && filterOpts.branch !== 'ALL') {
      targetTeachers = targetTeachers.filter((t) => t.branch === filterOpts.branch);
    }
    if (Array.isArray(filterOpts.selectedIds) && filterOpts.selectedIds.length) {
      targetTeachers = targetTeachers.filter((t) => filterOpts.selectedIds.includes(t.id));
    }

    const cellMap = {};
    placements.forEach((pl) => {
      (pl.teacher_ids || []).forEach((tid) => {
        if (!cellMap[tid]) cellMap[tid] = {};
        for (let k = 0; k < pl.length; k++) cellMap[tid][`${pl.day_index}_${pl.start_period + k}`] = pl;
      });
    });

    const pages = [];
    dayChunks.forEach((dChunk, chunkIdx) => {
      const dayTitle = dayChunks.length > 1 ? ` (Günler: ${dChunk.map((d) => d.name).join(', ')})` : '';
      const rowsHtml = targetTeachers.map((t) => {
        const m = computeTeacherDayMetrics(t.id, placements, allDays.length);
        const tds = dChunk.map(({ origDay, cIdx }) =>
          Array.from({ length: periods }, (_, p) => {
            if (((state.grid.slots[origDay] && state.grid.slots[origDay][p]) || 'ACTIVE') === 'BLOCKED') return `<td style="text-align:center;color:#94a3b8;background:#f1f5f9;">—</td>`;
            const pl = cellMap[t.id] && cellMap[t.id][`${cIdx}_${p}`];
            if (pl) {
              return `<td style="text-align:center;padding:2px;"><div style="font-weight:800;font-size:0.86em;">${escapeHtml(pl.class_name)}</div><div style="font-size:0.75em;color:#065f46;">${escapeHtml(pl.course_code)}</div></td>`;
            }
            const isUnav = t.availability && t.availability[origDay] && t.availability[origDay][p] === 'UNAVAILABLE';
            return `<td style="text-align:center;color:${isUnav ? '#ef4444' : '#cbd5e1'};">${isUnav ? '×' : '·'}</td>`;
          }).join('')
        ).join('');
        return `<tr><td><div style="font-weight:700;">${escapeHtml(t.name)}</div><div style="font-size:0.78em;color:#64748b;">${escapeHtml(t.branch)}</div></td>${tds}<td style="text-align:center;font-weight:800;">${m.totalHours}</td><td style="text-align:center;font-weight:800;">${m.totalGaps}</td></tr>`;
      }).join('');

      pages.push(`
        <div class="doc-page">
          ${renderHeaderBlock(state, `Öğretmen Çarşaf Programı${dayTitle}`, isDraft)}
          <table class="tt-table">
            <thead>
              <tr>
                <th rowspan="2" style="width:135px;">Öğretmen / Branş</th>
                ${dChunk.map((d) => `<th colspan="${periods}">${d.name}</th>`).join('')}
                <th rowspan="2" style="width:38px;">Saat</th>
                <th rowspan="2" style="width:38px;">Boş</th>
              </tr>
              <tr>
                ${dChunk.map(() => Array.from({ length: periods }, (_, p) => `<th>${p + 1}</th>`).join('')).join('')}
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          ${renderFooterBlock(state, isDraft, chunkIdx + 1, dayChunks.length)}
        </div>
      `);
    });
    return pages.join('');
  }

  function buildQualityReportPageHtml(state, helpers, editorLogic, isDraft) {
    const rep = computeDetailedReports(state, helpers, editorLogic);
    const s = rep.summary;

    return `
      <div class="doc-page">
        ${renderHeaderBlock(state, 'Genel Program Kalite ve Yük Raporu', isDraft)}
        <div class="summary-strip">
          <span><strong>Toplam Şube:</strong> ${s.totalClasses}</span>
          <span><strong>Toplam Öğretmen:</strong> ${s.totalTeachers}</span>
          <span><strong>Yerleşen / Hedef Saat:</strong> ${s.totalPlacedHours} / ${s.totalTargetHours} sa</span>
          <span><strong>Eksik Saat:</strong> ${s.missingHoursTotal} sa</span>
          <span><strong>Toplam Boş Pencere:</strong> ${s.totalGaps}</span>
          <span><strong>Kilitli Blok:</strong> ${s.lockedBlocksCount}</span>
          <span><strong>Çakışma / İhlal:</strong> ${s.violationCount}</span>
        </div>

        <h4 style="margin:12px 0 4px;font-size:1em;">1. Öğretmen Yük ve Pencere Raporu</h4>
        <table class="tt-table">
          <thead>
            <tr>
              <th>Öğretmen</th><th>Branş</th><th>Haftalık Saat</th>
              ${s.dayShorts.map((ds) => `<th style="width:38px;">${ds}</th>`).join('')}
              <th>Çalıştığı Gün</th><th>Boş Pencere</th><th>Maks. Ardışık</th>
            </tr>
          </thead>
          <tbody>
            ${rep.teacherRows.map((r) => `
              <tr>
                <td style="font-weight:700;">${escapeHtml(r.name)}</td>
                <td>${escapeHtml(r.branch)}</td>
                <td style="text-align:center;font-weight:700;">${r.totalHours} / ${r.maxWeekly}</td>
                ${r.dailyHours.map((dh) => `<td style="text-align:center;">${dh}</td>`).join('')}
                <td style="text-align:center;">${r.workingDays}</td>
                <td style="text-align:center;font-weight:700;">${r.gaps}</td>
                <td style="text-align:center;">${r.maxConsecutive}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <h4 style="margin:12px 0 4px;font-size:1em;">2. Sınıf Ders Dağılım Raporu</h4>
        <table class="tt-table">
          <thead>
            <tr>
              <th>Şube</th><th>Hedef Saat</th><th>Yerleşen Saat</th><th>Eksik Saat</th>
              ${s.dayShorts.map((ds) => `<th style="width:38px;">${ds}</th>`).join('')}
              <th>Blok Bütünlüğü</th>
            </tr>
          </thead>
          <tbody>
            ${rep.classRows.map((c) => `
              <tr>
                <td style="font-weight:700;">${escapeHtml(c.name)}</td>
                <td style="text-align:center;">${c.targetHours}</td>
                <td style="text-align:center;font-weight:700;">${c.placedHours}</td>
                <td style="text-align:center;">${c.missingHours}</td>
                ${c.dailyHours.map((dh) => `<td style="text-align:center;">${dh}</td>`).join('')}
                <td style="text-align:center;font-weight:700;">${c.blockIntegrityOk ? 'Tam' : 'Eksik/Sorunlu'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${renderSignatureBlock(state)}
        ${renderFooterBlock(state, isDraft, 1, 1)}
      </div>
    `;
  }

  function wrapFullPrintableHtml(pagesHtml, exportSettings = {}) {
    return `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8" /><title>Ders Programı Çıktısı</title><style>${getPrintCss(exportSettings)}</style></head><body>${pagesHtml}</body></html>`;
  }

  /* =========================================================================
     4. GERÇEK EXCEL (.XLSX) 7 SAYFALI ÇALIŞMA KİTABI ÜRETİCİ (BÖLÜM 7)
     ========================================================================= */
  function applySheetFormatting(ws, colWidths, hasAutoFilter = true) {
    ws['!cols'] = colWidths.map((w) => ({ wch: w }));
    if (hasAutoFilter && ws['!ref']) {
      ws['!autofilter'] = { ref: ws['!ref'] };
    }
    ws['!views'] = [{ state: 'frozen', ySplit: 1 }];
    return ws;
  }

  function buildExcelWorkbook(XLSX, state, helpers, editorLogic) {
    const valInfo = checkScheduleValidityForExport(state, helpers, editorLogic);
    const rep = valInfo.report;
    const gridStats = helpers.getSlotStats();
    const periods = state.grid.periodsPerDay;
    const classes = helpers.getCurrentClasses();
    const teachers = helpers.getCurrentTeachers();
    const rooms = helpers.getCurrentRooms();
    const placements = (state.solution && Array.isArray(state.solution.placements)) ? state.solution.placements : [];
    const tNameMap = Object.fromEntries(teachers.map((t) => [t.id, t.name]));
    const tShortMap = Object.fromEntries(teachers.map((t) => [t.id, t.shortCode || t.name.slice(0, 3).toUpperCase()]));
    const rNameMap = Object.fromEntries(rooms.map((r) => [r.id, r.name]));
    const bell = helpers.computeBellSchedule ? helpers.computeBellSchedule() : { primary: [] };

    const wb = XLSX.utils.book_new();
    const draftPrefix = valInfo.isDraft ? ' [TASLAK - DOGRULANMAMIS]' : '';

    // 1. Sınıf Programları
    const s1Rows = [['Şube', 'Gün', 'Ders Sırası', 'Saat Aralığı', 'Ders Kodu', 'Ders Adı', 'Öğretmen', 'Özel Derslik', 'Kilit Durumu'].map(sanitizeExcelCell)];
    placements.forEach((pl) => {
      const origDay = gridStats.activeDayIndices[pl.day_index];
      const dayName = DAY_NAMES[origDay] || `Gün ${pl.day_index + 1}`;
      const tNames = (pl.teacher_ids || []).map((id) => tNameMap[id] || '').filter(Boolean).join(' / ');
      const rName = pl.room_id ? (rNameMap[pl.room_id] || '') : '';
      const locked = editorLogic && editorLogic.isPlacementLocked(pl, state.pinnedPlacementIds, state.lockedTeacherIds).locked ? 'Kilitli' : 'Normal';
      for (let k = 0; k < pl.length; k++) {
        const pIdx = pl.start_period + k;
        const b = bell.primary[pIdx] || { start: '', end: '' };
        s1Rows.push([
          pl.class_name,
          dayName,
          `${pIdx + 1}. Ders`,
          b.start ? `${b.start}-${b.end}` : '',
          pl.course_code,
          pl.course_name,
          tNames,
          rName,
          locked
        ].map(sanitizeExcelCell));
      }
    });
    XLSX.utils.book_append_sheet(wb, applySheetFormatting(XLSX.utils.aoa_to_sheet(s1Rows), [12, 14, 12, 14, 12, 28, 26, 18, 12]), 'Sinif Programlari');

    // 2. Öğretmen Programları
    const s2Rows = [['Öğretmen', 'Branş', 'Gün', 'Ders Sırası', 'Şube', 'Ders Kodu', 'Ders Adı', 'Özel Derslik'].map(sanitizeExcelCell)];
    teachers.forEach((t) => {
      const tPl = placements.filter((p) => (p.teacher_ids || []).includes(t.id));
      tPl.forEach((pl) => {
        const origDay = gridStats.activeDayIndices[pl.day_index];
        const dayName = DAY_NAMES[origDay] || `Gün ${pl.day_index + 1}`;
        const rName = pl.room_id ? (rNameMap[pl.room_id] || '') : '';
        for (let k = 0; k < pl.length; k++) {
          s2Rows.push([t.name, t.branch, dayName, `${pl.start_period + k + 1}. Ders`, pl.class_name, pl.course_code, pl.course_name, rName].map(sanitizeExcelCell));
        }
      });
    });
    XLSX.utils.book_append_sheet(wb, applySheetFormatting(XLSX.utils.aoa_to_sheet(s2Rows), [24, 22, 14, 12, 10, 12, 28, 18]), 'Ogretmen Programlari');

    // 3. Sınıf Çarşaf
    const s3Header = ['Şube'];
    gridStats.activeDayIndices.forEach((d) => { for (let p = 0; p < periods; p++) s3Header.push(`${DAY_SHORT[d]}-${p + 1}`); });
    s3Header.push('Toplam Saat');
    const s3Rows = [s3Header.map(sanitizeExcelCell)];
    classes.forEach((cls) => {
      const row = [cls.name];
      let tot = 0;
      gridStats.activeDayIndices.forEach((_, cIdx) => {
        for (let p = 0; p < periods; p++) {
          const pl = placements.find((x) => x.class_id === cls.id && x.day_index === cIdx && p >= x.start_period && p < x.start_period + x.length);
          if (pl) {
            tot++;
            const ts = (pl.teacher_ids || []).map((id) => tShortMap[id] || '').filter(Boolean).join('/');
            row.push(`${pl.course_code}${ts ? ' (' + ts + ')' : ''}`);
          } else row.push('');
        }
      });
      row.push(tot);
      s3Rows.push(row.map(sanitizeExcelCell));
    });
    XLSX.utils.book_append_sheet(wb, applySheetFormatting(XLSX.utils.aoa_to_sheet(s3Rows), [12, ...Array(gridStats.activeDayIndices.length * periods).fill(11), 12]), 'Sinif Carsaf');

    // 4. Öğretmen Çarşaf
    const s4Header = ['Öğretmen', 'Branş'];
    gridStats.activeDayIndices.forEach((d) => { for (let p = 0; p < periods; p++) s4Header.push(`${DAY_SHORT[d]}-${p + 1}`); });
    s4Header.push('Toplam Saat', 'Boş Pencere');
    const s4Rows = [s4Header.map(sanitizeExcelCell)];
    rep.teacherRows.forEach((tr) => {
      const row = [tr.name, tr.branch];
      gridStats.activeDayIndices.forEach((_, cIdx) => {
        for (let p = 0; p < periods; p++) {
          const pl = placements.find((x) => (x.teacher_ids || []).includes(tr.id) && x.day_index === cIdx && p >= x.start_period && p < x.start_period + x.length);
          row.push(pl ? `${pl.class_name} ${pl.course_code}` : '');
        }
      });
      row.push(tr.totalHours, tr.gaps);
      s4Rows.push(row.map(sanitizeExcelCell));
    });
    XLSX.utils.book_append_sheet(wb, applySheetFormatting(XLSX.utils.aoa_to_sheet(s4Rows), [24, 20, ...Array(gridStats.activeDayIndices.length * periods).fill(10), 12, 12]), 'Ogretmen Carsaf');

    // 5. Özel Derslikler
    const s5Rows = [['Derslik Adı', 'Tür', 'Kapasite (Sınıf)', 'Haftalık Kullanım (Saat)', 'Boş Kapasite (Saat)', 'Kullanan Dersler', 'İhlal Sayısı'].map(sanitizeExcelCell)];
    rep.roomRows.forEach((rm) => {
      s5Rows.push([rm.name, rm.roomType, rm.capacity, rm.usedHours, rm.freeCapacityHours, rm.coursesList.join(', '), rm.violations].map(sanitizeExcelCell));
    });
    XLSX.utils.book_append_sheet(wb, applySheetFormatting(XLSX.utils.aoa_to_sheet(s5Rows), [22, 18, 16, 22, 20, 42, 14]), 'Ozel Derslikler');

    // 6. Öğretmen Ders Yükleri
    const s6Header = ['Öğretmen Adı', 'Branş', 'Haftalık Ders', 'Maks. Yük', ...rep.summary.dayShorts.map((d) => `${d} (Saat)`), 'Çalıştığı Gün', 'Boş Pencere', 'Maks. Ardışık'].map(sanitizeExcelCell);
    const s6Rows = [s6Header];
    rep.teacherRows.forEach((tr) => {
      s6Rows.push([tr.name, tr.branch, tr.totalHours, tr.maxWeekly, ...tr.dailyHours, tr.workingDays, tr.gaps, tr.maxConsecutive].map(sanitizeExcelCell));
    });
    XLSX.utils.book_append_sheet(wb, applySheetFormatting(XLSX.utils.aoa_to_sheet(s6Rows), [24, 22, 14, 12, ...Array(rep.summary.dayShorts.length).fill(10), 14, 14, 14]), 'Ogretmen Ders Yukleri');

    // 7. Program Kalite Raporu
    const s7Rows = [
      ['Gösterge', 'Değer', 'Açıklama'].map(sanitizeExcelCell),
      ['Program Durumu', (valInfo.isValid ? 'DOĞRULANMIŞ GEÇERLİ PROGRAM' : 'TASLAK – DOĞRULANMAMIŞ') + draftPrefix, valInfo.message].map(sanitizeExcelCell),
      ['Doğrulama Zamanı', valInfo.validatedAt, 'Google OR-Tools CP-SAT'].map(sanitizeExcelCell),
      ['Toplam Şube Sayısı', rep.summary.totalClasses, ''].map(sanitizeExcelCell),
      ['Toplam Öğretmen Sayısı', rep.summary.totalTeachers, ''].map(sanitizeExcelCell),
      ['Haftalık Hedef Ders Yükü', rep.summary.totalTargetHours, 'Saat'].map(sanitizeExcelCell),
      ['Yerleşen Ders Saati', rep.summary.totalPlacedHours, 'Saat'].map(sanitizeExcelCell),
      ['Eksik Ders Saati', rep.summary.missingHoursTotal, 'Saat'].map(sanitizeExcelCell),
      ['Toplam Öğretmen Boş Pencere', rep.summary.totalGaps, 'İlk ve son ders arası boş saatler'].map(sanitizeExcelCell),
      ['Kilitli Ders Bloğu Sayısı', rep.summary.lockedBlocksCount, ''].map(sanitizeExcelCell),
      ['Çakışma ve Kısıt İhlali Sayısı', rep.summary.violationCount, ''].map(sanitizeExcelCell)
    ];
    XLSX.utils.book_append_sheet(wb, applySheetFormatting(XLSX.utils.aoa_to_sheet(s7Rows), [30, 32, 46], false), 'Program Kalite Raporu');

    return { workbook: wb, validation: valInfo };
  }

  return {
    escapeHtml,
    sanitizeWindowsFilename,
    sanitizeExcelCell,
    createDefaultExportSettings,
    EvrakPlusAuthService,
    computeTeacherDayMetrics,
    computeDetailedReports,
    checkScheduleValidityForExport,
    buildClassTimetablePageHtml,
    buildTeacherTimetablePageHtml,
    buildCarsafPagesHtml,
    buildQualityReportPageHtml,
    wrapFullPrintableHtml,
    buildExcelWorkbook
  };
});
