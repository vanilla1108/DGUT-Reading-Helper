// ==UserScript==
// @name         DGUT求是读书-全自动阅读助手
// @namespace    http://tampermonkey.net/
// @version      3.2.1
// @license MIT
// @description  DGUT莞工求是读书计划自动阅读助手 — 获取优学院真实阅读时长、自动翻页/章节
// @author       vanilla、DeepSeek
// @match        https://ua.dgut.edu.cn/learnCourse/learnCourse.html?*
// @match        https://*.ulearning.cn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @downloadURL https://update.greasyfork.org/scripts/577055/DGUT%E6%B1%82%E6%98%AF%E8%AF%BB%E4%B9%A6%E9%98%85%E8%AF%BB%E5%8A%A9%E6%89%8B-%E8%87%AA%E5%8A%A8%E7%BF%BB%E9%A1%B5%2B%E8%AE%A1%E6%97%B6%E5%99%A8.user.js
// @updateURL https://update.greasyfork.org/scripts/577055/DGUT%E6%B1%82%E6%98%AF%E8%AF%BB%E4%B9%A6%E9%98%85%E8%AF%BB%E5%8A%A9%E6%89%8B-%E8%87%AA%E5%8A%A8%E7%BF%BB%E9%A1%B5%2B%E8%AE%A1%E6%97%B6%E5%99%A8.meta.js
// ==/UserScript==

(function() {
    'use strict';

    const PAGE_WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const HOST_RE = /^https:\/\/ua\.dgut\.edu\.cn\/learnCourse\/learnCourse\.html\?.*/i;
    const KEY = 'dgut_single_file_helper_config';
    const RECORDS_KEY = 'dgut_reading_records';
    const MSG = 'DGUT_SINGLE_FILE_READER_SYNC';
    const SAVE_INTERVAL = 30;
    const D = { posX:20, posY:120, readerSec:30, readerAutoStart:true };
    const MIN_BOOK_SEC = 4 * 3600 + 10;
    const NAV_SEC = 3;
    const cachedCourseId = new URL(location.href).searchParams.get('courseId') || '';

    if (HOST_RE.test(location.href)) {
        if (window.__DGUT_SINGLE_FILE_INITED__) return;
        window.__DGUT_SINGLE_FILE_INITED__ = true;
        initHost();
        return;
    }
    bootstrapReader();

    // --- 书目标识 & 持久化 ---

    function getActiveSectionName() {
        const activePage = document.querySelector('.page-name.active');
        if (!activePage) return '';
        const sectionItem = activePage.closest('.section-item');
        if (!sectionItem) return '';
        const nameEl = sectionItem.querySelector('.section-name .text');
        return nameEl ? trimName(nameEl.textContent) : '';
    }

    function getBookKey() {
        const name = getActiveSectionName();
        return name ? (cachedCourseId ? `${cachedCourseId}|${name}` : name) : (cachedCourseId || location.href);
    }

    function loadRecords() { return GM_getValue(RECORDS_KEY, {}); }
    function saveRecords(r) { GM_setValue(RECORDS_KEY, r); }
    function getBookTime(k) { return Math.max(0, parseInt(loadRecords()[k], 10) || 0); }
    function setBookTime(k, s) { const r = loadRecords(); r[k] = Math.max(0, Math.floor(s)); saveRecords(r); }

    // --- 常用工具 ---

    function readCfg() {
        const r = GM_getValue(KEY, D);
        if (!r || typeof r !== 'object') return { ...D };
        const sec = parseInt(r.readerSec, 10);
        return {
            posX: parseInt(r.posX,10)||D.posX,
            posY: parseInt(r.posY,10)||D.posY,
            readerSec: sec > 0 ? sec : D.readerSec,
            readerAutoStart: r.readerAutoStart !== false
        };
    }

    function getActivePageName() {
        const activePage = document.querySelector('.page-name.active');
        if (!activePage) return '';
        const textEl = activePage.querySelector('.text span') || activePage.querySelector('.text');
        return textEl ? trimName(textEl.textContent) : '';
    }

    function getBookDisplayName() {
        const section = getActiveSectionName();
        const page = getActivePageName();
        if (!section && !page) return '未识别';
        return page ? section + ' - ' + page : section;
    }

    function koUnwrap(val) { return typeof val === 'function' ? val() : val; }
    function trimName(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

    function getServerSideBookTimes() {
        const vm = PAGE_WIN.koLearnCourseViewModel;
        if (!vm) return null;
        const course = koUnwrap(vm.course);
        if (!course) return null;
        const chapters = koUnwrap(course.chapters);
        if (!chapters) return null;
        const result = {};
        chapters.forEach(function(chapter) {
            const sections = koUnwrap(chapter.sections);
            if (!sections) return;
            sections.forEach(function(section) {
                let name = '';
                try { name = trimName(koUnwrap(section.name)); } catch(e) {}
                if (!name) return;
                const key = cachedCourseId ? cachedCourseId + '|' + name : name;
                let total = 0;
                try {
                    const secRec = koUnwrap(section.record);
                    if (secRec && secRec.sectionStudyTime !== undefined) {
                        total = koUnwrap(secRec.sectionStudyTime) || 0;
                    }
                } catch(e) {}
                if (total === 0) {
                    const pages = koUnwrap(section.pages);
                    if (pages) {
                        pages.forEach(function(page) {
                            try {
                                const record = koUnwrap(page.record);
                                if (record) {
                                    total += (koUnwrap(record.studyTime) || 0) + (koUnwrap(record.lastStudyTime) || 0);
                                }
                            } catch(e) {}
                        });
                    }
                }
                if (total > 0) result[key] = total;
            });
        });
        return result;
    }

    function syncServerTime(bookKey, accumulated, logFn) {
        const serverTimes = getServerSideBookTimes();
        if (!serverTimes) return accumulated;
        const records = loadRecords();
        let updated = false;
        Object.keys(serverTimes).forEach(function(key) {
            const serverSec = serverTimes[key];
            const localSec = records[key] || 0;
            if (serverSec > localSec) {
                records[key] = serverSec;
                updated = true;
                if (logFn) logFn('服务端同步：' + key + ' ' + fmt(localSec) + ' → ' + fmt(serverSec));
            }
        });
        if (updated) saveRecords(records);
        if (bookKey && serverTimes[bookKey] && serverTimes[bookKey] > accumulated) {
            accumulated = serverTimes[bookKey];
        }
        return accumulated;
    }

    function fmt(t) {
        t = Math.max(0, t);
        return `${String(Math.floor(t/3600)).padStart(2,'0')}:${String(Math.floor(t%3600/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`;
    }

    // --- 主页面（课程页） ---

    function initHost() {
        let bookKey = getBookKey();
        let accumulated = getBookTime(bookKey);
        let sessionStart = Date.now();
        let lastSave = accumulated;
        let timer = null;
        let drag = false, dx, dy;
        const cfg = readCfg();
        let currentPageId = null;
        let pageStartTime = Date.now();
        let cachedFlatList = [];
        let flatListDirty = true;
        let holdPageId = null;

        function getFlatList(vm) {
            if (flatListDirty) {
                cachedFlatList = buildFlatPageList(vm);
                flatListDirty = false;
            }
            return cachedFlatList;
        }

        function getCurrentPageIdFromVM(vm) {
            try { return pageId(vm.currentPage?.()); } catch(e) { return null; }
        }

        function pageId(page) {
            if (!page) return null;
            return typeof page.id === 'function' ? page.id() : page.id;
        }

        function isPageComplete(page) {
            try {
                const record = koUnwrap(page.record);
                return record ? !!koUnwrap(record.status) : false;
            } catch(e) { return false; }
        }

        function getMoveLabel(fromItem, toItem) {
            if (!fromItem || !toItem) return '切换';
            if (pageId(fromItem.chapter) !== pageId(toItem.chapter)) return '切换下一章';
            if (pageId(fromItem.section) !== pageId(toItem.section)) return '切换下一本书';
            return '切换下一节';
        }

        function formatMoveTarget(item) {
            if (!item) return '(未知)';
            const chapterName = trimName(koUnwrap(item.chapter && item.chapter.name));
            const sectionName = trimName(koUnwrap(item.section && item.section.name));
            const pageName = trimName(koUnwrap(item.page && item.page.name));
            if (chapterName && sectionName) return chapterName + ' / ' + sectionName + ' - ' + pageName;
            if (sectionName) return sectionName + ' - ' + pageName;
            return pageName || '(未知)';
        }

        document.head.appendChild(Object.assign(document.createElement('style'), {
            textContent: '#dgut-single-helper-panel{background:rgba(28,28,30,.82);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);color:#e5e5e7;padding:0;border-radius:16px;position:fixed;z-index:100000;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;min-width:230px;box-shadow:0 12px 40px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08);user-select:none;overflow:hidden}#dgut-drag-handle{cursor:move;padding:9px 14px;background:rgba(255,255,255,.04);border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:space-between;gap:8px}#dgut-drag-handle h4{margin:0;background:linear-gradient(90deg,#007aff,#34c759);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase}#dgut-collapse-btn{cursor:pointer;font-size:14px;font-weight:700;color:rgba(255,255,255,.4);width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:5px;transition:background .15s,color .15s}#dgut-collapse-btn:hover{background:rgba(255,255,255,.1);color:#fff}#dgut-single-helper-panel.collapsed{min-width:200px}#dgut-single-helper-panel.collapsed .dgut-panel-body>:not(#timer-display):not(#progress-bar-wrap):not(#btn-pause-wrap){display:none}#dgut-single-helper-panel.collapsed .dgut-panel-body{padding:12px}#dgut-single-helper-panel.collapsed #timer-display{font-size:28px;margin:0 0 6px}#dgut-single-helper-panel.collapsed #btn-pause-wrap{margin-bottom:0;margin-top:8px}#dgut-single-helper-panel.collapsed .dgut-btn-primary{height:30px;font-size:12px}.dgut-panel-body{padding:14px}#timer-display{font-weight:800;color:#fff;font-size:34px;font-variant-numeric:tabular-nums;letter-spacing:1px;line-height:1;text-align:center;margin:2px 0 8px;text-shadow:0 2px 12px rgba(0,122,255,.3)}#progress-bar-wrap{height:4px;background:rgba(255,255,255,.1);border-radius:2px;margin:6px 0;overflow:hidden}#progress-bar-fill{height:100%;background:linear-gradient(90deg,#007aff,#34c759);border-radius:2px;transition:width .6s cubic-bezier(.34,1.56,.64,1);box-shadow:0 0 8px rgba(0,122,255,.3)}#progress-text{font-size:10px;font-weight:600;color:rgba(255,255,255,.4);text-align:center;margin-bottom:8px}#book-name-display{font-size:11px;color:rgba(255,255,255,.55);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;margin-bottom:10px;padding:3px 8px;background:rgba(255,255,255,.03);border-radius:6px}#btn-pause-wrap{margin-bottom:12px}.dgut-btn{border:none;border-radius:9px;cursor:pointer;font-size:13px;font-weight:600;transition:all .15s cubic-bezier(.4,0,.2,1);display:flex;align-items:center;justify-content:center;outline:0}.dgut-btn:hover{filter:brightness(1.08)}.dgut-btn:active{transform:scale(.97)}.dgut-btn-primary{color:#fff;width:100%;height:36px;background:linear-gradient(135deg,#43e97b,#38f9d7);box-shadow:0 4px 12px rgba(67,233,123,.25)}.dgut-btn-ghost{color:rgba(255,255,255,.85);background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);height:24px;padding:0 10px;font-size:11px;font-weight:500}.dgut-btn-ghost:hover{background:rgba(255,255,255,.13);border-color:rgba(255,255,255,.2)}#auto-row,#server-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:11px;color:rgba(255,255,255,.5)}#server-row #server-time-display{flex:1;min-width:0}#auto-row .row-label{color:rgba(255,255,255,.4);font-size:11px;flex-shrink:0}#auto-row .row-unit{font-size:11px;color:rgba(255,255,255,.4);margin-right:auto}#reader-sec{width:42px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.1);border-radius:5px;color:#fff;text-align:center;padding:3px;font-size:12px;outline:0;transition:border-color .15s}#reader-sec:focus{border-color:#007aff}#reader-status{display:flex;align-items:center;gap:6px;font-size:10px;color:rgba(255,255,255,.4);margin-bottom:10px}#status-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;background:#ffcc80}#status-dot.active{background:#34c759;box-shadow:0 0 6px #34c759;animation:dgut-pulse 2s infinite}@keyframes dgut-pulse{0%,100%{opacity:1}50%{opacity:.5}}#dgut-log-header{display:flex;align-items:center;justify-content:space-between;cursor:pointer;margin-bottom:6px;padding-top:8px;border-top:1px solid rgba(255,255,255,.06)}#dgut-log-title{font-size:10px;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.5px;font-weight:700}#dgut-log-toggle{font-size:10px;color:rgba(255,255,255,.25)}#dgut-log-container{height:90px;overflow-y:auto;background:rgba(0,0,0,.22);border-radius:7px;padding:6px 8px;font-size:10px;font-family:Consolas,monospace;line-height:1.5;scrollbar-width:thin;transition:all .25s ease}#dgut-log-container.collapsed{height:0;padding:0;opacity:0;overflow:hidden}#dgut-log-container::-webkit-scrollbar{width:4px}#dgut-log-container::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:2px}.dgut-log-line{padding:1px 0;color:rgba(255,255,255,.55)}.dgut-log-time{color:rgba(255,255,255,.18);margin-right:6px}'
        }));

        const p = Object.assign(document.createElement('div'), {
            id: 'dgut-single-helper-panel',
            style: `top:${cfg.posY}px;right:${cfg.posX}px`
        });
        p.innerHTML = `<div id="dgut-drag-handle">
  <h4>DGUT 求是阅读助手</h4>
  <span id="dgut-collapse-btn" title="折叠/展开">−</span>
</div>
<div class="dgut-panel-body">
  <div id="timer-display">${fmt(accumulated)}</div>
  <div id="progress-bar-wrap"><div id="progress-bar-fill" style="width:0%"></div></div>
  <div id="progress-text">0%</div>
  <div id="book-name-display" title="${bookKey}">${getBookDisplayName()}</div>
  <div id="btn-pause-wrap">
    <button id="btn-pause" class="dgut-btn dgut-btn-primary">开始</button>
  </div>
  <div id="auto-row">
    <span class="row-label">间隔</span>
    <input type="number" id="reader-sec" value="${cfg.readerSec}" min="1">
    <span class="row-unit">秒/页</span>
    <button id="btn-apply-reader" class="dgut-btn dgut-btn-ghost">保存</button>
  </div>
  <div id="reader-status"><span id="status-dot"></span><span id="status-text">就绪</span></div>
  <div id="server-row">
    <span id="server-time-display">服务端: --</span>
    <button id="btn-sync-server" class="dgut-btn dgut-btn-ghost">同步</button>
  </div>
  <div id="dgut-log-header">
    <span id="dgut-log-title">日志</span>
    <span id="dgut-log-toggle">▼</span>
  </div>
  <div id="dgut-log-container"></div>
</div>`;
        document.body.appendChild(p);

        const td = document.getElementById('timer-display');
        const bd = document.getElementById('book-name-display');
        const sd = document.getElementById('server-time-display');
        const pb = document.getElementById('btn-pause');
        const sb = document.getElementById('btn-sync-server');
        let lastServerSync = 0;
        const SYNC_INTERVAL = 300;

        function status(t, c) {
            const st = document.getElementById('status-text');
            const dot = document.getElementById('status-dot');
            if (st) st.textContent = t;
            if (dot) { dot.style.background = c || '#ffcc80'; dot.className = c === '#34c759' ? 'active' : ''; }
        }
        function log(msg) {
            const c = document.getElementById('dgut-log-container');
            if(!c) return;
            const n = new Date();
            const t = `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}`;
            const l = document.createElement('div');
            l.className = 'dgut-log-line';
            l.innerHTML = `<span class="dgut-log-time">[${t}]</span>${msg}`;
            c.appendChild(l);
            c.scrollTop = c.scrollHeight;
            while(c.children.length > 100) c.removeChild(c.firstChild);
        }
        function saveCfg() { GM_setValue(KEY, cfg); }
        function updateTimerDisplay(sec) {
            td.textContent = fmt(sec);
            const pct = Math.min(100, Math.floor(sec / MIN_BOOK_SEC * 100));
            const bar = document.getElementById('progress-bar-fill');
            const pctEl = document.getElementById('progress-text');
            if (bar) bar.style.width = pct + '%';
            if (pctEl) pctEl.textContent = pct + '%';
        }
        function getTotal() { return accumulated + Math.floor((Date.now() - sessionStart) / 1000); }
        function persist() { const t = getTotal(); setBookTime(bookKey, t); lastSave = t; log('存档：' + fmt(t)); }

        function syncReader() {
            saveCfg();
            const payload = { type: MSG, intervalSec: cfg.readerSec, autoStart: cfg.readerAutoStart };
            let n = 0;
            Array.from(document.querySelectorAll('iframe')).forEach(f => {
                try { if(f.contentWindow){ f.contentWindow.postMessage(payload, '*'); n++; } } catch(e) {}
            });
            let txt;
            if (n > 0) {
                txt = cfg.readerAutoStart ? '阅读中·'+cfg.readerSec+'秒/页' : '已暂停·'+cfg.readerSec+'秒/页';
            } else {
                txt = '等待阅读器连接';
            }
            status(txt, n > 0 ? '#34c759' : '#ffcc80');
        }

        function saveReader() {
            const s = parseInt(document.getElementById('reader-sec').value,10);
            if (s > 0) { cfg.readerSec = s; syncReader(); log('自动操作间隔已设为 ' + s + ' 秒/页'); }
            else alert('请输入大于 0 的数字');
        }

        function solveModal() {
            const b1 = document.querySelector('button.btn-submit');
            if(b1&&b1.offsetParent!==null) { b1.click(); log('自动关闭弹窗 (btn-submit)'); }
            const b2 = document.querySelector('#alertModal .btn-submit, .modal.fade.in .btn-hollow, .modal.in .btn-primary');
            if(b2) {
                const r = b2.getBoundingClientRect();
                if (r.width > 0 || r.height > 0) { b2.click(); log('自动关闭弹窗 (modal)'); }
            }
        }

        function solveChapterModal() {
            const modal = document.querySelector('.stat-page.chapter-stat');
            if (!modal) return false;
            const rect = modal.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return false;
            const btns = modal.querySelectorAll('.stat-next .btn-hollow');
            if (btns.length === 0) return false;
            if (getTotal() < MIN_BOOK_SEC) {
                btns[0].click();
                pageStartTime = Date.now();
                log('弹窗：未满4h，留在本章');
            } else if (btns.length > 1) {
                btns[1].click();
                currentPageId = null;
                pageStartTime = Date.now();
                log('弹窗：已满4h，切换下一章');
            } else {
                btns[0].click();
                pageStartTime = Date.now();
                log('弹窗：已满4h，已是最后一章，留在本章');
            }
            return true;
        }

        let antiDetectTimer = null;
        function setupAntiDetect() {
            antiDetectTimer = setInterval(() => {
                document.dispatchEvent(new MouseEvent('mousemove', {
                    clientX: 100 + Math.random()*500, clientY: 100 + Math.random()*300, bubbles: false
                }));
            }, 30000);
        }

        function tick() {
            solveModal();
            const modalHandled = solveChapterModal();
            const currentKey = getBookKey();
            if (currentKey !== bookKey) {
                setBookTime(bookKey, getTotal());
                bookKey = currentKey;
                accumulated = getBookTime(bookKey);
                sessionStart = Date.now();
                lastSave = accumulated;
                flatListDirty = true;
                holdPageId = null;
                const dispName = getBookDisplayName();
                bd.textContent = dispName;
                bd.title = bookKey;
                refreshServerDisplay();
                log('当前书目：' + dispName);
            }
            const vm = PAGE_WIN.koLearnCourseViewModel;
            if(!modalHandled && vm && vm.currentPage && cfg.readerAutoStart) {
                const flatList = getFlatList(vm);
                const page = vm.currentPage();
                const pId = pageId(page);
                if(pId && pId !== currentPageId) {
                    const prevPid = currentPageId;
                    const prevIdx = prevPid ? findPageIndex(flatList, prevPid) : -1;
                    const currentIdx = findPageIndex(flatList, pId);
                    const prevItem = prevIdx >= 0 ? flatList[prevIdx] : null;
                    const currentItem = currentIdx >= 0 ? flatList[currentIdx] : null;
                    currentPageId = pId;
                    pageStartTime = Date.now();
                    const moveLabel = getMoveLabel(prevItem, currentItem);
                    log(moveLabel + '：' + formatMoveTarget(currentItem));
                    const dispName = getBookDisplayName();
                    bd.textContent = dispName;
                    bd.title = bookKey;
                }
                if (getTotal() >= MIN_BOOK_SEC) {
                    if(currentPageId && Date.now() - pageStartTime >= NAV_SEC * 1000) {
                        const next = vm.nextPageName?.();
                        const currentIdx = findPageIndex(flatList, currentPageId);
                        const currentItem = currentIdx >= 0 ? flatList[currentIdx] : null;
                        const nextFlatItem = currentIdx >= 0 && currentIdx < flatList.length - 1 ? flatList[currentIdx + 1] : null;
                        const isNoMore = !next || next === vm.i18nMessageText?.()?.noMore;
                        const crossesSection = !!(currentItem && nextFlatItem && pageId(currentItem.section) !== pageId(nextFlatItem.section));
                        const nextMoveLabel = getMoveLabel(currentItem, nextFlatItem);
                        const isChapterEnd = isNoMore || (next && next.includes('统计')) || crossesSection;
                        if (isChapterEnd) {
                            const result = advanceToNextSection(vm, currentPageId);
                            if (result.success) {
                                holdPageId = null;
                                currentPageId = null;
                                pageStartTime = Date.now();
                                log('已满4h，' + result.moveLabel + '：' + result.targetText);
                                setTimeout(function() { syncReader(); }, 1500);
                            } else if (result.atEnd) {
                                stopReading();
                                log('全部书目已读完');
                            }
                        } else {
                            vm.goNextPage();
                            pageStartTime = Date.now();
                            log(nextMoveLabel + '：' + formatMoveTarget(nextFlatItem));
                        }
                    }
                } else {
                    ensureHoldPage(vm, flatList);
                }
            }
            const total = getTotal();
            updateTimerDisplay(total);
            if (total - lastSave >= SAVE_INTERVAL) persist();
            if (Date.now() - lastServerSync >= SYNC_INTERVAL * 1000) {
                const newAcc = syncServerTime(bookKey, accumulated, log);
                if (newAcc !== accumulated) { sessionStart = Date.now(); lastSave = newAcc; }
                accumulated = newAcc;
                lastServerSync = Date.now();
                refreshServerDisplay();
            }
        }

        function startReading() {
            if (timer) return;
            sessionStart = Date.now();
            timer = setInterval(tick, 1000);
            pb.textContent = '暂停';
            pb.style.background = 'linear-gradient(135deg, #475569, #64748b)';
            pb.style.boxShadow = '0 4px 12px rgba(71,85,105,.25)';
            cfg.readerAutoStart = true;
            const vm = PAGE_WIN.koLearnCourseViewModel;
            if(vm && vm.currentPage) {
                const p = vm.currentPage();
                currentPageId = pageId(p);
                pageStartTime = Date.now();
            }
            syncReader();
            log('开始阅读');
        }

        function stopReading() {
            if (!timer) return;
            clearInterval(timer);
            timer = null;
            persist();
            pb.textContent = '开始';
            pb.style.background = '';
            pb.style.boxShadow = '';
            cfg.readerAutoStart = false;
            syncReader();
            log('暂停阅读');
        }

        function refreshServerDisplay() {
            try {
                const st = getServerSideBookTimes();
                if (st && st[bookKey]) {
                    sd.textContent = '服务端: ' + fmt(st[bookKey]);
                    return true;
                } else if (st) {
                    sd.textContent = '服务端: 暂无记录';
                    return true;
                } else {
                    sd.textContent = '服务端: 获取失败';
                    return false;
                }
            } catch(e) {
                console.error('[DGUT Reader] refreshServerDisplay error:', e);
                sd.textContent = '服务端: 出错';
                return false;
            }
        }

        function doSync() {
            refreshServerDisplay();
            const before = accumulated;
            accumulated = syncServerTime(bookKey, accumulated, log);
            sessionStart = Date.now();
            lastSave = accumulated;
            lastServerSync = Date.now();
            updateTimerDisplay(accumulated);
            refreshServerDisplay();
            if (accumulated > before) {
                log('已从服务端同步，当前累计: ' + fmt(accumulated));
            } else {
                log('服务端数据已是最新');
            }
        }

        function buildFlatPageList(vm) {
            const course = koUnwrap(vm.course);
            const chapters = koUnwrap(course.chapters);
            if (!chapters) return [];
            const flatList = [];
            chapters.forEach(function(chapter) {
                const sections = koUnwrap(chapter.sections);
                if (!sections) return;
                sections.forEach(function(section) {
                    if (koUnwrap(section.isHide)) return;
                    const pages = koUnwrap(section.pages);
                    if (!pages) return;
                    pages.forEach(function(page) {
                        flatList.push({ page: page, section: section, chapter: chapter });
                    });
                });
            });
            return flatList;
        }

        function findPageIndex(flatList, pid) {
            return flatList.findIndex(function(item) {
                const id = pageId(item.page);
                return String(id) === String(pid);
            });
        }

        function advanceToNextSection(vm, currentPageId) {
            const flatList = getFlatList(vm);
            const currentIdx = findPageIndex(flatList, currentPageId);
            if (currentIdx >= 0 && currentIdx < flatList.length - 1) {
                const current = flatList[currentIdx];
                const next = flatList[currentIdx + 1];
                vm.selectPage(next.page, next.section, next.chapter);
                return {
                    success: true,
                    moveLabel: getMoveLabel(current, next),
                    targetText: formatMoveTarget(next)
                };
            }
            return { success: false, atEnd: flatList.length > 0 };
        }

        function ensureHoldPage(vm, flatList) {
            if (!currentPageId) return;
            const currentIdx = findPageIndex(flatList, currentPageId);
            if (currentIdx < 0) return;
            const currentItem = flatList[currentIdx];
            const secId = pageId(currentItem.section);
            const sameSectionItems = flatList.filter(function(item) {
                return pageId(item.section) === secId;
            });
            if (sameSectionItems.length === 0) return;

            if (!isPageComplete(currentItem.page)) {
                if (holdPageId !== currentPageId) {
                    holdPageId = currentPageId;
                    log('未满4h，停留在当前节刷时长：' + trimName(koUnwrap(currentItem.page.name)));
                }
                return;
            }

            let target = sameSectionItems.find(function(item) {
                return !isPageComplete(item.page);
            });
            if (!target) target = sameSectionItems[sameSectionItems.length - 1];

            const targetPid = pageId(target.page);
            if (targetPid === currentPageId) {
                holdPageId = currentPageId;
                return;
            }
            if (holdPageId === targetPid) return;

            vm.selectPage(target.page, target.section, target.chapter);
            holdPageId = targetPid;
            currentPageId = null;
            pageStartTime = Date.now();
            log('未满4h，当前节已完成，切换并停留：' + trimName(koUnwrap(target.page.name)));
            setTimeout(function() { syncReader(); }, 1500);
        }

        const onDragMove = e => {
            const l = e.clientX-dx, t = e.clientY-dy;
            Object.assign(p.style, { left: l+'px', right: 'auto', top: t+'px' });
            cfg.posX = Math.max(0, window.innerWidth-(l+p.offsetWidth));
            cfg.posY = Math.max(0, t);
        };
        const onDragUp = () => {
            drag = false;
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', onDragUp);
            saveCfg();
        };
        document.getElementById('dgut-drag-handle').addEventListener('mousedown', e => {
            drag = true; dx = e.clientX-p.offsetLeft; dy = e.clientY-p.offsetTop;
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragUp);
        });

        document.getElementById('reader-sec').addEventListener('keydown', e => { if(e.key==='Enter') saveReader(); });
        document.getElementById('btn-apply-reader').addEventListener('click', saveReader);
        pb.addEventListener('click', () => { timer ? stopReading() : startReading(); });
        sb.addEventListener('click', doSync);

        const collapseBtn = document.getElementById('dgut-collapse-btn');
        collapseBtn.addEventListener('mousedown', e => e.stopPropagation());
        collapseBtn.addEventListener('click', e => {
            e.stopPropagation();
            const collapsed = p.classList.toggle('collapsed');
            collapseBtn.textContent = collapsed ? '+' : '−';
        });

        document.getElementById('dgut-log-header').addEventListener('click', function() {
            const c = document.getElementById('dgut-log-container');
            const t = document.getElementById('dgut-log-toggle');
            if (c.classList.contains('collapsed')) {
                c.classList.remove('collapsed');
                t.textContent = '▼';
            } else {
                c.classList.add('collapsed');
                t.textContent = '▶';
            }
        });

        updateTimerDisplay(accumulated);
        log('DGUT 阅读助手已启动');
        log('当前书目：' + getBookDisplayName());
        if(cfg.readerAutoStart) {
            startReading();
        } else {
            sessionStart = Date.now();
            pb.textContent = '开始';
        }
        syncReader();
        window.addEventListener('message', function(e) {
            if (e.data && e.data.type === 'DGUT_LOG') {
                log('[iframe] ' + e.data.text);
            }
        });
        setupAntiDetect();
        let startupSyncRetries = 0;
        function startupSync() {
            const newAcc = syncServerTime(bookKey, accumulated, null);
            if (newAcc !== accumulated || startupSyncRetries === 0) {
                if (newAcc !== accumulated) { sessionStart = Date.now(); lastSave = newAcc; }
                accumulated = newAcc;
                lastServerSync = Date.now();
                updateTimerDisplay(accumulated);
            }
            const hasServerData = refreshServerDisplay();
            if (!hasServerData && startupSyncRetries < 10) {
                startupSyncRetries++;
                setTimeout(startupSync, 3000);
            } else if (hasServerData) {
                log('服务端时长已同步');
            }
        }
        setTimeout(startupSync, 3000);
        window.addEventListener('load', () => { setTimeout(syncReader,1200); setTimeout(syncReader,2600); }, { once: true });
    }

    // --- 阅读器 iframe 页 ---

    function initReader() {
        if(window.__DGUT_SINGLE_FILE_READER_INITED__) return;
        window.__DGUT_SINGLE_FILE_READER_INITED__ = true;
        let timer = null, state, lastFlipLogAt = 0, lastLoopBack = 0;
        const LOG = 'DGUT_LOG';

        function rlog(msg) {
            console.log('[DGUT Reader]', msg);
            try { window.parent.postMessage({ type: LOG, text: msg }, '*'); } catch(e) {}
        }

        function clickNext() {
            const b = document.querySelector('#nextBtn');
            if(!b || b.style.display === 'none' || b.disabled) return;
            const pageIdxEl = document.getElementById('pageIndex');
            const pageCntEl = document.getElementById('pageCount');
            if (pageIdxEl && pageCntEl) {
                const cur = parseInt(pageIdxEl.innerHTML, 10);
                const total = parseInt(pageCntEl.innerHTML, 10);
                if (total > 0 && cur >= total) {
                    const now = Date.now();
                    if (now - lastLoopBack < 3000) return;
                    lastLoopBack = now;
                    try {
                        const pw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                        if (typeof pw.goPage === 'function') { pw.goPage(0); }
                        else if (typeof goPage === 'function') { goPage(0); }
                        else {
                            const s = document.createElement('script');
                            s.textContent = 'goPage(0);';
                            document.head.appendChild(s);
                            setTimeout(function() { if (s.parentNode) s.parentNode.removeChild(s); }, 100);
                        }
                        lastFlipLogAt = 0;
                        rlog('已至末页，回到第一页循环');
                        return;
                    } catch(e) { rlog('回到第一页失败：' + e.message); }
                }
            }
            b.click();
            const now = Date.now();
            if (now - lastFlipLogAt >= 60000) {
                lastFlipLogAt = now;
                rlog('翻页');
            }
        }
        function stop() { if(!timer) return; clearInterval(timer); timer = null; rlog('翻页定时器已停止'); }
        function start(s) { if(timer) return; timer = setInterval(clickNext, s*1000); rlog('翻页定时器已启动：' + s + '秒/页'); }
        function apply(s, auto) { stop(); if(auto!==false) start(s); }

        window.addEventListener('message', e => {
            const d = e.data;
            if(!d||d.type!==MSG) return;
            state = readCfg();
            const sec = parseInt(d.intervalSec, 10);
            state.readerSec = sec > 0 ? sec : D.readerSec;
            state.readerAutoStart = d.autoStart !== false;
            GM_setValue(KEY, state);
            rlog('收到同步：' + sec + '秒/页，' + (state.readerAutoStart ? '自动' : '暂停'));
            apply(state.readerSec, state.readerAutoStart);
        });

        function tryStart() {
            state = readCfg();
            apply(state.readerSec, state.readerAutoStart);
        }
        if (document.readyState === 'complete') {
            setTimeout(tryStart, 500);
        } else {
            window.addEventListener('load', () => setTimeout(tryStart, 1200), { once: true });
        }
    }

    function bootstrapReader() {
        const init = () => document.querySelector('#nextBtn') ? (initReader(), true) : false;
        if(init()) { console.log('[DGUT Reader] 阅读器已连接'); return; }
        let n = 0, t = setInterval(() => { n++; if(init()||n>=20) clearInterval(t); }, 500);
        window.addEventListener('load', () => setTimeout(init, 1200), { once: true });
    }
})();
