// app.js
// 聽力練習系統 - 前端邏輯（Firestore 版本）

import { 
    auth, db, doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs,
    onAuthStateChanged, signOut, increment, arrayUnion, onSnapshot
} from './firebase-config.js';

// ==================== 全局變量 ====================
let currentUser = null;
let currentUserData = null;
let isGuestMode = false;
let unsubscribeUserListener = null;

// 單元數據
let unitsIndex = { units: [] };
let currentUnitId = '';
let currentPracticeData = null;

// 用戶進度
let userProgress = {};

// 徽章配置
const BADGE_THRESHOLD = 90;
const PASS_THRESHOLD = 80;

// 音頻播放相關變量
let segments = [];
let currentSegmentIndex = 0;
let isPlaying = false;
let currentUtterance = null;
let waitingForAnswer = false;
let currentWaitingQuestionId = null;

// 懸浮視窗狀態
let isTextHidden = false;
let isTranslationHidden = true;
let isMinimized = true;
let userWidth = null;
let userHeight = null;

// 訪客模式相關
const guestPublisher = 'Open示範';

// 當前用戶的年級
let currentUserGrade = null;

// 當前練習的 book/chapter/practice ID
let currentBook = null;
let currentChapter = null;
let currentPractice = null;

// 防抖定時器
let updateStatsTimeout = null;

// 在線狀態更新定時器
let onlineStatusInterval = null;

// 章節排程相關變量
let systemConfig = null;

const ONLINE_STATUS_INTERVAL = 60000;

// ==================== 儲存管理器（數據隔離）====================
const StorageManager = {
    getCurrentUserId() {
        if (isGuestMode) return 'guest';
        if (currentUser?.uid) return currentUser.uid;
        return null;
    },
    
    getPrefix() {
        const userId = this.getCurrentUserId();
        if (!userId) return 'temp_';
        return `${userId}_`;
    },
    
    saveProgress(progress) {
        const key = `${this.getPrefix()}userProgress`;
        localStorage.setItem(key, JSON.stringify(progress));
        console.log(`💾 儲存進度到: ${key}`);
    },
    
    loadProgress() {
        const key = `${this.getPrefix()}userProgress`;
        const saved = localStorage.getItem(key);
        return saved ? JSON.parse(saved) : {};
    },
    
    saveAnswers(practiceId, answers) {
        const key = `${this.getPrefix()}practice_${practiceId}`;
        localStorage.setItem(key, JSON.stringify(answers));
    },
    
    loadAnswers(practiceId) {
        const key = `${this.getPrefix()}practice_${practiceId}`;
        const saved = localStorage.getItem(key);
        return saved ? JSON.parse(saved) : {};
    },
    
    removeAnswers(practiceId) {
        const key = `${this.getPrefix()}practice_${practiceId}`;
        localStorage.removeItem(key);
    }
};

// ==================== 輔助函數 ====================
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

function showToast(message, type = 'info') {
    const existing = document.querySelector('.toast-message');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast-message';
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; padding: 10px 16px;
        border-radius: 8px; color: white; background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3B82F6'};
        z-index: 10001; font-size: 13px; font-weight: 500;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        pointer-events: none;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ==================== 訪客模式輔助函數 ====================
function getGuestGrade() {
    return localStorage.getItem('guestGrade') || 'P2';
}

function setGuestGrade(grade) {
    localStorage.setItem('guestGrade', grade);
}

// ==================== 章節排程函數 ====================
async function loadSystemConfig() {
    try {
        const configRef = doc(db, 'system_config', 'settings');
        const configSnap = await getDoc(configRef);
        
        if (configSnap.exists()) {
            systemConfig = configSnap.data();
            console.log('📅 系統配置已載入:', {
                currentChapter: systemConfig.currentChapterId,
                totalChapters: systemConfig.totalChapters,
                mapping: systemConfig.chapterMapping
            });
            return true;
        } else {
            console.warn('⚠️ 找不到系統配置，使用默認顯示');
            return false;
        }
    } catch (error) {
        console.error('載入系統配置失敗:', error);
        return false;
    }
}

function getVisibleChapters(allChapters) {
    if (!systemConfig || !systemConfig.chapterMapping) {
        return allChapters;
    }
    
    const now = new Date();
    const visibleChapterIds = [];
    
    for (let i = 0; i < 3; i++) {
        const targetDate = new Date(now);
        targetDate.setMonth(now.getMonth() - i);
        const yearMonth = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
        
        const chapterId = systemConfig.chapterMapping[yearMonth];
        if (chapterId && !visibleChapterIds.includes(chapterId)) {
            visibleChapterIds.push(chapterId);
        }
    }
    
    return allChapters.filter(chapter => visibleChapterIds.includes(chapter.id));
}

function getChapterDisplayTitle(chapter, offset = 0) {
    let chapterTitle = '';
    if (typeof chapter === 'object') {
        chapterTitle = chapter.title || '';
    } else {
        chapterTitle = chapter;
    }
    
    if (!systemConfig || !systemConfig.chapterMapping) {
        return chapterTitle;
    }
    
    const now = new Date();
    const targetDate = new Date(now);
    targetDate.setMonth(now.getMonth() - offset);
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    
    return `${year}.${String(month).padStart(2, '0')} · ${chapterTitle}`;
}

// ==================== 在線狀態更新 ====================
async function updateLastActive() {
    if (isGuestMode) return;
    if (!currentUser) return;
    
    try {
        const userRef = doc(db, 'users', currentUser.uid);
        await updateDoc(userRef, {
            lastActiveAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('更新在線狀態失敗:', error);
    }
}

// ==================== stats 計算函數 ====================
function calculateStats(progress) {
    const practices = Object.values(progress).filter(p => p.percentage !== undefined && p.percentage !== null);
    
    if (practices.length === 0) {
        return {
            totalPractices: 0,
            avgPercentage: 0,
            badges: { gold: 0, pass: 0 }
        };
    }
    
    const totalPractices = practices.length;
    const sumPercentage = practices.reduce((sum, p) => sum + p.percentage, 0);
    const avgPercentage = Math.round(sumPercentage / totalPractices);
    const goldCount = practices.filter(p => p.badge === '🎖️').length;
    const passCount = practices.filter(p => p.badge === '✓').length;
    
    return {
        totalPractices,
        avgPercentage,
        badges: { gold: goldCount, pass: passCount }
    };
}

function shouldUpdateStats(oldStats, newProgress) {
    const newStats = calculateStats(newProgress);
    return oldStats.totalPractices !== newStats.totalPractices ||
           oldStats.avgPercentage !== newStats.avgPercentage ||
           oldStats.badges.gold !== newStats.badges.gold ||
           oldStats.badges.pass !== newStats.badges.pass;
}

async function updateUserStats(userId, progress) {
    const newStats = calculateStats(progress);
    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);
    const currentStats = userSnap.data()?.stats || { totalPractices: 0, avgPercentage: 0, badges: { gold: 0, pass: 0 } };
    
    if (shouldUpdateStats(currentStats, progress)) {
        await updateDoc(userRef, { stats: newStats, updatedAt: new Date().toISOString() });
        console.log('📊 stats 已更新:', newStats);
        return true;
    }
    return false;
}

function debouncedUpdateStats(userId, progress) {
    if (updateStatsTimeout) {
        clearTimeout(updateStatsTimeout);
    }
    updateStatsTimeout = setTimeout(async () => {
        await updateUserStats(userId, progress);
        updateStatsTimeout = null;
    }, 1000);
}

// ==================== 角色語音 ====================
const roleNames = { host: '主持人', narrator: '旁白', announcer: '播音員', caller: '來賓', default: '旁白' };
const roleIcons = { host: 'fa-microphone-alt', narrator: 'fa-bullhorn', announcer: 'fa-bullhorn', caller: 'fa-phone-alt', default: 'fa-headphones' };

function getVoiceForRole(role) {
    const voices = window.speechSynthesis.getVoices();
    const roleMap = { 'host': { gender: 'female', lang: 'en-GB' }, 'narrator': { gender: 'male', lang: 'en-GB' }, 'announcer': { gender: 'male', lang: 'en-GB' } };
    const target = roleMap[role.toLowerCase()] || { lang: 'en-GB' };
    let matched = voices.find(v => v.lang.includes(target.lang) && (target.gender ? (v.name.includes(target.gender === 'female' ? 'Female' : 'Male')) : true));
    if (!matched) matched = voices.find(v => v.lang.includes('en-GB'));
    if (!matched) matched = voices.find(v => v.lang.includes('en'));
    return matched || voices[0];
}

// ==================== 解析腳本 ====================
function parseSegments(audioScript) {
    const segments = [];
    if (!audioScript || !Array.isArray(audioScript)) return segments;
    
    for (const item of audioScript) {
        let role = item.speaker.toLowerCase();
        let text = item.original;
        let translation = item.translation || null;
        
        if (role === 'host') role = 'host';
        else if (role === 'narrator') role = 'narrator';
        else if (role === 'announcer') role = 'announcer';
        else role = 'caller';
        
        const questionPattern = /(Question \d+: [^?]+[?。！]?)/gi;
        const questionMatches = [...text.matchAll(questionPattern)];
        
        if (questionMatches.length > 1 && role === 'narrator') {
            let lastIndex = 0;
            for (const qMatch of questionMatches) {
                const qText = qMatch[0];
                const qIndex = text.indexOf(qText, lastIndex);
                if (qIndex > lastIndex) {
                    const beforeText = text.substring(lastIndex, qIndex).trim();
                    if (beforeText) {
                        segments.push({ role, text: beforeText, translation });
                    }
                }
                segments.push({ role, text: qText, translation });
                lastIndex = qIndex + qText.length;
            }
            const remaining = text.substring(lastIndex).trim();
            if (remaining) {
                segments.push({ role, text: remaining, translation });
            }
        } else {
            segments.push({ role, text, translation });
        }
    }
    
    return segments.filter(s => s.text.length > 0);
}

// ==================== 用戶權限過濾（核心修改）====================
function filterUnitsByUser(units) {
    console.log('🔍 filterUnitsByUser 被調用，輸入單元數量:', units.length);

    // 1. 管理員：顯示所有教材
    if (!isGuestMode && currentUserData?.role === 'admin') {
        console.log('👑 管理員模式：顯示所有教材');
        return units;
    }

    // 2. 訪客模式
    if (isGuestMode) {
        const guestGrade = getGuestGrade();
        const filtered = units.filter(unit => {
            const gradeMatch = unit.grade?.includes(guestGrade) || false;
            const publisherMatch = unit.publisher?.includes(guestPublisher) || false;
            return gradeMatch && publisherMatch;
        });
        console.log('👤 訪客模式過濾後:', filtered.length, '/', units.length);
        return filtered;
    }

    // 3. 一般登入使用者
    if (currentUser && currentUserData) {
        const userGrades = currentUserData.grade || [];
        const userPublishers = currentUserData.publishers || [];
        
        // 檢查試用期
        const trialEndAt = currentUserData.trialEndAt;
        const isTrial = trialEndAt && new Date(trialEndAt) > new Date();
        
        console.log('📋 用戶過濾參數:', {
            grades: userGrades,
            publishers: userPublishers,
            isTrial: isTrial,
            trialEndAt: trialEndAt
        });

        // 嚴格模式：年級為空 → 看不到任何教材
        if (userGrades.length === 0) {
            console.warn('⚠️ 使用者缺少年級設定，無法顯示任何教材');
            return [];
        }

        // 決定有效的出版社列表
        let effectivePublishers = [...userPublishers];
        
        // 試用期且沒有分配任何出版社 → 使用預設教材 (Open示範)
        if (isTrial && effectivePublishers.length === 0) {
            effectivePublishers = [guestPublisher];
            console.log('🎁 試用期：使用預設教材', guestPublisher);
        }

        // 如果 effectivePublishers 仍為空 → 看不到教材
        if (effectivePublishers.length === 0) {
            console.warn('⚠️ 使用者沒有教材權限（試用期已過且未分配出版社）');
            return [];
        }

        const filtered = units.filter(unit => {
            // 年級交集檢查
            const unitGrades = unit.grade || [];
            const gradeMatch = unitGrades.some(g => userGrades.includes(g));

            // 出版社交集檢查
            const unitPublishers = unit.publisher || [];
            const publisherMatch = unitPublishers.some(p => effectivePublishers.includes(p));

            return gradeMatch && publisherMatch;
        });

        console.log('👤 一般使用者過濾後:', filtered.length, '/', units.length);
        if (filtered.length > 0) {
            console.log('過濾後第一個單元的 publisher:', filtered[0].publisher);
        }
        return filtered;
    }

    return [];
}

// ==================== 顯示無教材提示 ====================
function showNoMaterialMessage() {
    const container = document.getElementById('questionsContainer');
    if (container) {
        container.innerHTML = `
            <div class="question-item" style="text-align:center; padding: 60px 20px; color: #64748b;">
                <i class="fas fa-book-open" style="font-size: 64px; margin-bottom: 20px; display: block; color: #94a3b8;"></i>
                <h3 style="font-size: 18px; margin-bottom: 8px; color: #334155;">目前沒有可用的教材</h3>
                <p style="font-size: 14px;">請聯絡管理員開通權限</p>
            </div>
        `;
    }
    const titleEl = document.getElementById('practice-title');
    if (titleEl) titleEl.innerHTML = '暫無教材';
    const descEl = document.getElementById('practice-desc');
    if (descEl) descEl.innerHTML = '您的帳號尚未被分配任何教材權限';
    
    const floatingPlayer = document.getElementById('floatingPlayer');
    if (floatingPlayer) {
        floatingPlayer.style.display = 'none';
    }
}

// ==================== 側邊欄渲染 ====================
function renderSidebar() {
    const container = document.getElementById('booksContainer');
    if (!container) return;
    
    if (!unitsIndex.units || unitsIndex.units.length === 0) {
        container.innerHTML = '<div style="padding: 0.75rem; color: #94a3b8;">暫無教材</div>';
        return;
    }
    
    let availableUnits = filterUnitsByUser(unitsIndex.units);
    
    if (availableUnits.length === 0) {
        container.innerHTML = '<div style="padding: 0.75rem; color: #94a3b8;">沒有符合的教材</div>';
        return;
    }
    
    // 構建章節列表
    const chaptersMap = new Map();
    availableUnits.forEach(unit => {
        const chapterId = unit.chapter || 'default';
        if (!chaptersMap.has(chapterId)) {
            chaptersMap.set(chapterId, {
                id: chapterId,
                title: unit.chapterTitle || `Chapter ${chapterId}`,
                practices: []
            });
        }
        chaptersMap.get(chapterId).practices.push(unit);
    });
    
    let chapterList = Array.from(chaptersMap.values());
    chapterList.sort((a, b) => {
        const numA = parseInt(a.id.replace('ch', '')) || 0;
        const numB = parseInt(b.id.replace('ch', '')) || 0;
        return numA - numB;
    });
    
    const visibleChapters = getVisibleChapters(chapterList);
    
    let html = '';
    for (let idx = 0; idx < visibleChapters.length; idx++) {
        const chapter = visibleChapters[idx];
        const chapterId = chapter.id;
        const displayTitle = getChapterDisplayTitle(chapter, idx);
        const hasActivePractice = chapter.practices.some(p => p.id === currentUnitId);
        const showClass = hasActivePractice ? 'show' : '';
        
        html += `
            <div class="chapter-item" data-chapter="${chapterId}">
                <i class="fas fa-folder-open"></i> ${escapeHtml(displayTitle)}
            </div>
            <div class="practice-list ${showClass}" id="practices-${chapterId}">
        `;
        
        chapter.practices.forEach(unit => {
            const isActive = currentUnitId === unit.id;
            html += `
                <div class="practice-link ${isActive ? 'active' : ''}" data-practice-id="${unit.id}">
                    <span>${escapeHtml(unit.title)}</span>
                    <span class="practice-badge"></span>
                </div>
            `;
        });
        
        html += `</div>`;
    }
    
    container.innerHTML = html;
    
    document.querySelectorAll('.chapter-item').forEach(chapter => {
        chapter.addEventListener('click', (e) => {
            e.stopPropagation();
            const chapterId = chapter.dataset.chapter;
            const practiceList = document.getElementById(`practices-${chapterId}`);
            if (practiceList) {
                practiceList.classList.toggle('show');
            }
        });
    });
    
    document.querySelectorAll('.practice-link').forEach(link => {
        link.addEventListener('click', () => {
            const unitId = link.dataset.practiceId;
            if (unitId) {
                loadUnit(unitId);
            }
        });
    });
    
    updateSidebarBadges();
    if (currentUnitId) {
        const levelMatch = currentUnitId.match(/^([a-zA-Z0-9]+)_/);
        if (levelMatch) {
            let level = levelMatch[1].toUpperCase();
            const levelTitle = `Level ${level}`;
            const levelElement = document.querySelector('.nav-section-title');
            if (levelElement) {
                levelElement.textContent = levelTitle;
            }
        }
    }
}

function updateSidebarBadges() {
    if (!userProgress) return;
    
    document.querySelectorAll('.practice-link').forEach(link => {
        const unitId = link.dataset.practiceId;
        const progress = userProgress[unitId];
        const badgeSpan = link.querySelector('.practice-badge');
        
        if (badgeSpan && progress) {
            let percentage, badge;
            if (typeof progress === 'number') {
                percentage = progress;
                badge = percentage >= BADGE_THRESHOLD ? '🎖️' : (percentage >= PASS_THRESHOLD ? '✓' : null);
            } else {
                percentage = progress.percentage;
                badge = progress.badge;
            }
            
            if (badge === '🎖️') {
                badgeSpan.innerHTML = `🎖️ ${percentage}%`;
            } else if (badge === '✓') {
                badgeSpan.innerHTML = `✓ ${percentage}%`;
            } else if (percentage !== null && percentage !== undefined) {
                badgeSpan.innerHTML = `${percentage}%`;
            } else {
                badgeSpan.innerHTML = '';
            }
        } else if (badgeSpan) {
            badgeSpan.innerHTML = '';
        }
    });
}

// ==================== 用戶介面更新 ====================
function updateUserInterface() {
    const userDetails = document.getElementById('userDetails');
    const logoutBtn = document.getElementById('logoutBtn');
    
    if (isGuestMode) {
        if (userDetails) {
            userDetails.innerHTML = `
                <div class="user-name">訪客模式</div>
                <div class="user-email">進度儲存在本機</div>
            `;
        }
        if (logoutBtn) {
            logoutBtn.style.display = 'inline-block';
            logoutBtn.onclick = () => {
                localStorage.removeItem('guestMode');
                localStorage.removeItem('guestGrade');
                window.location.href = './login.html';
            };
        }
        return;
    }
    
    if (currentUser) {
        const photoURL = currentUser.photoURL;
        const displayName = currentUser.displayName || currentUser.email || '會員';
        const roleLabel = currentUserData?.role === 'admin' ? '<span class="user-role">管理員</span>' : 
                         (currentUserData?.role === 'teacher' ? '<span class="user-role">老師</span>' : '');
        const gradeLabel = currentUserGrade ? `<span class="user-role" style="background:#e2e8f0;">${escapeHtml(currentUserGrade)}</span>` : '';
        
        if (userDetails) {
            userDetails.innerHTML = `
                ${photoURL ? `<img src="${photoURL}" class="user-avatar" alt="頭像">` : '<div class="user-avatar"><i class="fas fa-user"></i></div>'}
                <div>
                    <div class="user-name">${escapeHtml(displayName)} ${roleLabel} ${gradeLabel}</div>
                    <div class="user-email">${escapeHtml(currentUser.email)}</div>
                </div>
            `;
        }
        if (logoutBtn) {
            logoutBtn.style.display = 'inline-block';
            logoutBtn.onclick = handleLogout;
        }
    }
}

// ==================== 登出處理 ====================
async function handleLogout() {
    if (unsubscribeUserListener) {
        unsubscribeUserListener();
        unsubscribeUserListener = null;
    }
    
    if (onlineStatusInterval) {
        clearInterval(onlineStatusInterval);
        onlineStatusInterval = null;
    }
    
    if (currentUser && !isGuestMode) {
        try {
            await signOut(auth);
        } catch (error) {
            console.error('登出失敗:', error);
        }
    }
    
    if (isGuestMode) {
        localStorage.removeItem('guestMode');
        localStorage.removeItem('guestGrade');
    }
    
    window.location.href = './login.html';
}

// ==================== 載入單元索引 ====================
async function loadUnitsIndex() {
    try {
        if (!currentUser) {
            console.log('⏳ 等待用戶登入...');
            return false;
        }
        
        const indexRef = doc(db, 'materials_index', 'units-index');
        const indexSnap = await getDoc(indexRef);
        
        if (indexSnap.exists()) {
            unitsIndex = indexSnap.data();
            console.log('📚 單元索引已從 Firestore 載入:', unitsIndex.units?.length, '個單元');
        } else {
            console.error('找不到 units-index');
            unitsIndex = { units: [] };
            return false;
        }
        
        return true;
    } catch (error) {
        console.error('載入單元索引失敗:', error);
        unitsIndex = { units: [] };
        return false;
    }
}

// ==================== 載入單元 ====================
async function loadUnit(unitId) {
    if (!unitId) return;
    if (!currentUser) {
        showToast('請先登入', 'error');
        return;
    }
    
    if (isPlaying) {
        stopPlayback();
        isPlaying = false;
        const playBtn = document.getElementById('floatPlayBtn');
        if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
    }
    
    const scoreDisplay = document.getElementById('scoreDisplay');
    if (scoreDisplay) {
        scoreDisplay.innerHTML = '📊 ';
    }
    
    currentUnitId = unitId;
    
    const parts = unitId.split('_');
    if (parts.length >= 3) {
        currentBook = parts[0];
        currentChapter = parts[1];
        currentPractice = parts[2];
    } else {
        console.error('無法解析 unitId:', unitId);
        showToast('無法載入練習：單元 ID 格式錯誤', 'error');
        return;
    }
    
    try {
        const materialRef = doc(db, 'materials', unitId);
        const materialSnap = await getDoc(materialRef);
        
        if (!materialSnap.exists()) {
            showToast('找不到教材內容', 'error');
            return;
        }
        
        currentPracticeData = materialSnap.data();
        
        const levelMatch = unitId.match(/^([a-zA-Z0-9]+)_/);
        if (levelMatch) {
            let level = levelMatch[1].toUpperCase();
            const levelTitle = `Level ${level}`;
            const levelElement = document.querySelector('.nav-section-title');
            if (levelElement) {
                levelElement.textContent = levelTitle;
            }
        }
        
        segments = parseSegments(currentPracticeData.audioScript);
        currentSegmentIndex = 0;
        updateFloatingDisplay();
        clearAllHighlights();
        
        renderQuestions(currentPracticeData.questions);
        
        const titleEl = document.getElementById('practice-title');
        const descEl = document.getElementById('practice-desc');
        
        if (titleEl) {
            const unitInfo = unitsIndex.units.find(u => u.id === unitId);
            if (unitInfo && systemConfig && systemConfig.chapterMapping) {
                const chapterTitleText = unitInfo.chapterTitle || '';
                const now = new Date();
                const chNum = parseInt(unitInfo.chapter.replace('ch', ''));
                const offset = 3 - chNum;
                const targetDate = new Date(now);
                targetDate.setMonth(now.getMonth() - offset);
                const year = targetDate.getFullYear();
                const month = targetDate.getMonth() + 1;
                const mainTitle = `${year}年${month}月 · ${chapterTitleText}`;
                titleEl.innerHTML = escapeHtml(mainTitle);
            } else {
                titleEl.innerHTML = escapeHtml(currentPracticeData.title || '');
            }
        }
        
        if (descEl) {
            descEl.innerHTML = escapeHtml(currentPracticeData.desc || '');
        }
        
        document.querySelectorAll('.practice-link').forEach(link => {
            if (link.dataset.practiceId === unitId) {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });
        
        const activeLink = document.querySelector(`.practice-link[data-practice-id="${unitId}"]`);
        if (activeLink) {
            const chapterDiv = activeLink.closest('.practice-list');
            if (chapterDiv && !chapterDiv.classList.contains('show')) {
                chapterDiv.classList.add('show');
            }
        }
        
        window.scrollTo({ top: 0, behavior: 'smooth' });
        
    } catch (error) {
        console.error('載入單元失敗:', error);
        showToast('載入失敗：' + error.message, 'error');
        const container = document.getElementById('questionsContainer');
        if (container) {
            container.innerHTML = '<div class="question-item" style="text-align:center; color:#ef4444;">載入失敗</div>';
        }
    }
}

// ==================== 題目渲染 ====================
function renderQuestions(questions) {
    const container = document.getElementById('questionsContainer');
    if (!container) return;
    container.innerHTML = '';
    if (!questions || questions.length === 0) {
        container.innerHTML = '<div class="question-item" style="text-align:center;">📝 題目準備中</div>';
        return;
    }
    
    questions.forEach((q, idx) => {
        const qDiv = document.createElement('div');
        qDiv.className = 'question-item';
        qDiv.dataset.qid = q.id;
        
        let questionHtml = `<span class="question-text">${escapeHtml(q.text)}</span>`;
        let optionsHtml = '<div class="options">';
        
        if (q.type === 'single') {
            q.options.forEach((opt, optIdx) => {
                const letter = String.fromCharCode(65 + optIdx);
                optionsHtml += `
                    <div class="option-row" data-qid="${q.id}" data-letter="${letter}">
                        <label>
                            <input type="radio" name="q_${q.id}" value="${letter}">
                            <span>${letter}. ${escapeHtml(opt)}</span>
                        </label>
                        <span class="option-status" style="display:none;"></span>
                        <button class="explain-icon" style="display:none;" data-qid="${q.id}"><i class="fas fa-lightbulb"></i></button>
                    </div>
                `;
            });
        } else if (q.type === 'fill') {
            optionsHtml += `
                <div class="option-row" data-qid="${q.id}">
                    <label style="width:100%;">
                        <input type="text" name="q_${q.id}" class="fill-input" placeholder="請輸入答案" style="width:100%; padding:8px 12px; border:1px solid #cbd5e1; border-radius:8px;">
                    </label>
                    <span class="option-status" style="display:none;"></span>
                    <button class="explain-icon" style="display:none;" data-qid="${q.id}"><i class="fas fa-lightbulb"></i></button>
                </div>
            `;
        } else if (q.type === 'multi') {
            optionsHtml += `<div class="multi-options-area">`;
            q.options.forEach((opt, optIdx) => {
                const letter = String.fromCharCode(65 + optIdx);
                optionsHtml += `
                    <div class="option-row" data-qid="${q.id}" data-letter="${letter}">
                        <label>
                            <input type="checkbox" name="q_${q.id}" value="${letter}">
                            <span>${letter}. ${escapeHtml(opt)}</span>
                        </label>
                        <span class="option-status" style="display:none;"></span>
                        <button class="explain-icon" style="display:none;" data-qid="${q.id}"><i class="fas fa-lightbulb"></i></button>
                    </div>
                `;
            });
            optionsHtml += `
                <div class="multi-confirm-area" style="margin-top: 12px;">
                    <button class="multi-confirm-btn" data-qid="${q.id}" style="display: none; background: #1E3A8A; color: white; border: none; padding: 6px 16px; border-radius: 20px; font-size: 0.75rem; cursor: pointer;">
                        <i class="fas fa-check"></i> 確認答案
                    </button>
                </div>
            </div>`;
        }
        
        optionsHtml += '</div>';
        const explanation = q.explanation || "聽力原文中相關的句子可以幫助理解。";
        
        qDiv.innerHTML = `
            <div class="question-header">
                <span class="q-num">${idx + 1}</span>
                ${questionHtml}
            </div>
            ${optionsHtml}
            <div class="explanation-area" data-explain="${q.id}">
                <div class="explanation-label"><i class="fas fa-info-circle"></i>  解釋</div>
                <div class="explanation-text">${escapeHtml(explanation)}</div>
            </div>
        `;
        container.appendChild(qDiv);
    });
    
    const savedAnswers = StorageManager.loadAnswers(`${currentBook}_${currentChapter}_${currentPractice}`);
    
    questions.forEach(q => {
        const saved = savedAnswers[q.id];
        if (saved !== undefined && saved !== null && saved !== '') {
            if (q.type === 'single') {
                const radio = document.querySelector(`input[name="q_${q.id}"][value="${saved}"]`);
                if (radio) radio.checked = true;
            } else if (q.type === 'fill') {
                const input = document.querySelector(`input[name="q_${q.id}"]`);
                if (input) input.value = saved;
            } else if (q.type === 'multi') {
                if (Array.isArray(saved)) {
                    saved.forEach(val => {
                        const checkbox = document.querySelector(`input[name="q_${q.id}"][value="${val}"]`);
                        if (checkbox) checkbox.checked = true;
                    });
                }
            }
        }
    });
    
    attachEvents(questions);
}

function attachEvents(questions) {
    questions.forEach(q => {
        if (q.type === 'single') {
            const radios = document.querySelectorAll(`input[name="q_${q.id}"]`);
            radios.forEach(radio => {
                radio.onchange = () => {
                    const val = document.querySelector(`input[name="q_${q.id}"]:checked`)?.value;
                    if (val) {
                        const savedAnswers = StorageManager.loadAnswers(`${currentBook}_${currentChapter}_${currentPractice}`);
                        savedAnswers[q.id] = val;
                        StorageManager.saveAnswers(`${currentBook}_${currentChapter}_${currentPractice}`, savedAnswers);
                        continueAfterAnswer(q.id);
                    }
                };
            });
        } else if (q.type === 'fill') {
            const input = document.querySelector(`input[name="q_${q.id}"]`);
            if (input) {
                input.onchange = () => {
                    const val = input.value.trim();
                    const savedAnswers = StorageManager.loadAnswers(`${currentBook}_${currentChapter}_${currentPractice}`);
                    savedAnswers[q.id] = val;
                    StorageManager.saveAnswers(`${currentBook}_${currentChapter}_${currentPractice}`, savedAnswers);
                };
            }
        } else if (q.type === 'multi') {
            const checkboxes = document.querySelectorAll(`input[name="q_${q.id}"]`);
            checkboxes.forEach(cb => {
                cb.onchange = () => {
                    const selected = Array.from(document.querySelectorAll(`input[name="q_${q.id}"]:checked`)).map(c => c.value);
                    const savedAnswers = StorageManager.loadAnswers(`${currentBook}_${currentChapter}_${currentPractice}`);
                    savedAnswers[q.id] = selected;
                    StorageManager.saveAnswers(`${currentBook}_${currentChapter}_${currentPractice}`, savedAnswers);
                };
            });
        }
    });
    
    document.querySelectorAll('.explain-icon').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const qid = btn.dataset.qid;
            const explainArea = document.querySelector(`.explanation-area[data-explain="${qid}"]`);
            if (explainArea) explainArea.classList.toggle('show');
        };
    });
    
    document.querySelectorAll('.multi-confirm-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const qid = parseInt(btn.dataset.qid);
            confirmMultiChoice(qid);
        };
    });
}

// ==================== 音頻播放函數 ====================
function clearAllHighlights() {
    document.querySelectorAll('.question-item').forEach(item => {
        item.classList.remove('playing-highlight', 'waiting-answer');
    });
}

function highlightQuestion(questionId) {
    clearAllHighlights();
    if (questionId) {
        const qElement = document.querySelector(`.question-item[data-qid="${questionId}"]`);
        if (qElement) qElement.classList.add('playing-highlight');
    }
}

function playSegment(index) {
    stopPlayback();
    if (index >= segments.length) { stopExam(); return; }
    if (index < 0) return;
    currentSegmentIndex = index;
    const seg = segments[currentSegmentIndex];
    
    let textToSpeak = seg.text;
    textToSpeak = textToSpeak.replace(/_{2,}/g, '');
    textToSpeak = textToSpeak.replace(/_/g, '');
    textToSpeak = textToSpeak.replace(/\.{2,}/g, '');
    textToSpeak = textToSpeak.replace(/…/g, '');
    textToSpeak = textToSpeak.replace(/—/g, ' ');
    textToSpeak = textToSpeak.replace(/–/g, ' ');
    textToSpeak = textToSpeak.replace(/\[/g, '');
    textToSpeak = textToSpeak.replace(/\]/g, '');
    textToSpeak = textToSpeak.replace(/\*/g, '');
    textToSpeak = textToSpeak.replace(/#/g, '');
    textToSpeak = textToSpeak.replace(/@/g, 'at ');
    textToSpeak = textToSpeak.replace(/\(/g, '');
    textToSpeak = textToSpeak.replace(/\)/g, '');
    textToSpeak = textToSpeak.replace(/\s+/g, ' ').trim();
    
    const questionMatch = textToSpeak.match(/Question\s*(\d+)/i);
    if (questionMatch) {
        const qid = parseInt(questionMatch[1]);
        highlightQuestion(qid);
        currentWaitingQuestionId = qid;
    } else {
        clearAllHighlights();
        currentWaitingQuestionId = null;
    }
    updateFloatingDisplay();
    
    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.lang = 'en-GB';
    utterance.rate = 0.9;
    const voice = getVoiceForRole(seg.role);
    if (voice) utterance.voice = voice;
    currentUtterance = utterance;
    utterance.onend = () => {
        currentUtterance = null;
        if (isPlaying) {
            if (questionMatch) {
                const qid = parseInt(questionMatch[1]);
                const question = currentPracticeData?.questions?.find(q => q.id === qid);
                if (question) {
                    if (question.type === 'single') {
                        waitingForAnswer = true;
                        const qElement = document.querySelector(`.question-item[data-qid="${qid}"]`);
                        if (qElement) {
                            qElement.classList.remove('playing-highlight');
                            qElement.classList.add('waiting-answer');
                        }
                        return;
                    } else if (question.type === 'multi') {
                        waitingForAnswer = true;
                        const qElement = document.querySelector(`.question-item[data-qid="${qid}"]`);
                        if (qElement) {
                            qElement.classList.remove('playing-highlight');
                            qElement.classList.add('waiting-answer');
                            const confirmBtn = qElement.querySelector('.multi-confirm-btn');
                            if (confirmBtn) confirmBtn.style.display = 'inline-flex';
                        }
                        return;
                    }
                }
            }
            waitingForAnswer = false;
            if (currentSegmentIndex + 1 < segments.length) {
                playSegment(currentSegmentIndex + 1);
            } else {
                stopExam();
            }
        }
    };
    utterance.onerror = () => { currentUtterance = null; };
    window.speechSynthesis.speak(utterance);
}

function confirmMultiChoice(questionId) {
    if (waitingForAnswer && currentWaitingQuestionId === questionId) {
        const checkboxes = document.querySelectorAll(`input[name="q_${questionId}"]:checked`);
        const selected = Array.from(checkboxes).map(cb => cb.value);
        if (selected.length > 0) {
            const savedAnswers = StorageManager.loadAnswers(`${currentBook}_${currentChapter}_${currentPractice}`);
            savedAnswers[questionId] = selected;
            StorageManager.saveAnswers(`${currentBook}_${currentChapter}_${currentPractice}`, savedAnswers);
        }
        
        const qElement = document.querySelector(`.question-item[data-qid="${questionId}"]`);
        if (qElement) {
            const confirmBtn = qElement.querySelector('.multi-confirm-btn');
            if (confirmBtn) confirmBtn.style.display = 'none';
        }
        
        continueAfterAnswer(questionId);
    }
}

function continueAfterAnswer(questionId) {
    if (waitingForAnswer && currentWaitingQuestionId === questionId) {
        waitingForAnswer = false;
        const qElement = document.querySelector(`.question-item[data-qid="${questionId}"]`);
        if (qElement) {
            qElement.classList.remove('waiting-answer', 'playing-highlight');
            const confirmBtn = qElement.querySelector('.multi-confirm-btn');
            if (confirmBtn) confirmBtn.style.display = 'none';
        }
        currentWaitingQuestionId = null;
        if (currentSegmentIndex + 1 < segments.length) {
            playSegment(currentSegmentIndex + 1);
        } else {
            stopExam();
        }
    }
}

function stopPlayback() {
    window.speechSynthesis.cancel();
    if (currentUtterance) currentUtterance = null;
    waitingForAnswer = false;
    currentWaitingQuestionId = null;
    clearAllHighlights();
}

function stopExam() {
    stopPlayback();
    isPlaying = false;
    const playBtn = document.getElementById('floatPlayBtn');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
    clearAllHighlights();
}

function togglePlayPause() {
    if (isPlaying) {
        stopPlayback();
        isPlaying = false;
        const playBtn = document.getElementById('floatPlayBtn');
        if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
    } else {
        isPlaying = true;
        playSegment(currentSegmentIndex);
        const playBtn = document.getElementById('floatPlayBtn');
        if (playBtn) playBtn.innerHTML = '<i class="fas fa-pause"></i>';
    }
}

function prevSegment() {
    stopPlayback();
    isPlaying = false;
    const playBtn = document.getElementById('floatPlayBtn');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
    if (currentSegmentIndex > 0) {
        currentSegmentIndex--;
    } else {
        currentSegmentIndex = 0;
    }
    updateFloatingDisplay();
    waitingForAnswer = false;
    currentWaitingQuestionId = null;
    clearAllHighlights();
}

function nextSegment() {
    stopPlayback();
    isPlaying = false;
    const playBtn = document.getElementById('floatPlayBtn');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
    if (currentSegmentIndex + 1 < segments.length) {
        currentSegmentIndex++;
    }
    updateFloatingDisplay();
    waitingForAnswer = false;
    currentWaitingQuestionId = null;
    clearAllHighlights();
}

window.togglePlayPause = togglePlayPause;
window.prevSegment = prevSegment;
window.nextSegment = nextSegment;

// ==================== 重置練習 ====================
function resetCurrentPractice() {
    if (!currentBook || !currentChapter || !currentPractice) {
        showToast('沒有載入中的練習', 'error');
        return;
    }
    
    const practiceId = `${currentBook}_${currentChapter}_${currentPractice}`;
    StorageManager.removeAnswers(practiceId);
    
    document.querySelectorAll('.explain-icon').forEach(icon => icon.remove());
    document.querySelectorAll('.user-answer-row').forEach(row => row.remove());
    document.querySelectorAll('.correct-answer-row').forEach(row => row.remove());
    document.querySelectorAll('[data-input-id]').forEach(container => {
        const input = document.querySelector(`input[name="q_${container.dataset.inputId}"]`);
        if (input) {
            input.style.display = '';
            input.value = '';
            input.style.border = '';
            input.style.backgroundColor = '';
        }
        container.remove();
    });
    
    document.querySelectorAll('.fill-input').forEach(input => {
        input.style.borderColor = '';
        input.style.backgroundColor = '';
        input.style.display = '';
    });
    
    document.querySelectorAll('.option-row').forEach(row => {
        row.classList.remove('correct-highlight', 'wrong-highlight');
    });
    
    document.querySelectorAll('.option-status').forEach(span => {
        span.style.display = 'none';
        span.innerHTML = '';
    });
    
    if (currentPracticeData?.questions) {
        renderQuestions(currentPracticeData.questions);
    }
    
    const scoreDisplay = document.getElementById('scoreDisplay');
    if (scoreDisplay) scoreDisplay.innerHTML = '📊 ';
    
    clearAllHighlights();
    
    if (currentUser && !currentUser.isAnonymous && !isGuestMode) {
        debouncedUpdateStats(currentUser.uid, userProgress);
    }
}

// ==================== 核對答案 ====================
function checkAllAnswers() {
    if (!currentPracticeData?.questions) return;
    if (!currentBook || !currentChapter || !currentPractice) {
        showToast('沒有載入中的練習', 'error');
        return;
    }
    
    const practiceId = `${currentBook}_${currentChapter}_${currentPractice}`;
    
    function getCurrentAnswers() {
        const answers = {};
        document.querySelectorAll('.question-item').forEach(qElement => {
            const qid = parseInt(qElement.dataset.qid);
            if (isNaN(qid)) return;
            
            const radios = qElement.querySelectorAll('input[type="radio"]');
            if (radios.length > 0) {
                const checked = Array.from(radios).find(r => r.checked);
                if (checked) answers[qid] = checked.value;
                return;
            }
            
            const checkboxes = qElement.querySelectorAll('input[type="checkbox"]');
            if (checkboxes.length > 0) {
                const checked = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);
                if (checked.length > 0) answers[qid] = checked;
                return;
            }
            
            const fillInput = qElement.querySelector('.fill-input');
            if (fillInput) {
                const val = fillInput.value.trim();
                if (val) answers[qid] = val;
            }
        });
        return answers;
    }
    
    const currentAnswers = getCurrentAnswers();
    
    const unanswered = [];
    currentPracticeData.questions.forEach(q => {
        if (currentAnswers[q.id] === undefined) unanswered.push(q.id);
    });
    
    if (unanswered.length > 0) {
        showToast(`⚠️ 尚有 ${unanswered.length} 題未作答，請完成後再核對`, 'info');
        unanswered.forEach(qid => {
            const qElement = document.querySelector(`.question-item[data-qid="${qid}"]`);
            if (qElement) {
                qElement.style.transition = 'border 0.3s';
                qElement.style.borderLeft = '4px solid #f97316';
                setTimeout(() => {
                    if (qElement) qElement.style.borderLeft = '';
                }, 3000);
            }
        });
        return;
    }
    
    const savedAnswers = StorageManager.loadAnswers(practiceId);
    Object.assign(savedAnswers, currentAnswers);
    StorageManager.saveAnswers(practiceId, savedAnswers);
    
    let score = 0;
    const total = currentPracticeData.questions.length;
    
    document.querySelectorAll('.option-row').forEach(row => {
        row.classList.remove('correct-highlight', 'wrong-highlight');
        const statusSpan = row.querySelector('.option-status');
        if (statusSpan) {
            statusSpan.style.display = 'none';
            statusSpan.innerHTML = '';
        }
        const explainBtn = row.querySelector('.explain-icon');
        if (explainBtn) explainBtn.style.display = 'none';
    });
    document.querySelectorAll('.explanation-area').forEach(area => area.classList.remove('show'));
    
    currentPracticeData.questions.forEach(q => {
        const userAns = currentAnswers[q.id];
        let isCorrect = false;
        
        if (q.type === 'multi') {
            if (Array.isArray(userAns) && Array.isArray(q.answer)) {
                isCorrect = userAns.length === q.answer.length && userAns.every(ans => q.answer.includes(ans));
            }
        } else if (q.type === 'fill') {
            const correctAnswer = q.answer;
            const normalize = (str) => {
                if (!str || str === '') return '';
                return String(str).trim().toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, ' ').replace(/\s+/g, ' ').trim();
            };
            const normalizedUser = normalize(userAns);
            
            if (Array.isArray(correctAnswer)) {
                isCorrect = correctAnswer.some(ans => normalizedUser === normalize(ans));
            } else {
                isCorrect = normalizedUser === normalize(correctAnswer);
            }
            
            const qElement = document.querySelector(`.question-item[data-qid="${q.id}"]`);
            const input = qElement?.querySelector('.fill-input');
            const statusSpan = qElement?.querySelector('.option-status');
            const optionRow = qElement?.querySelector('.option-row');
            
            const existingCorrectRow = qElement?.querySelector('.correct-answer-row');
            if (existingCorrectRow) existingCorrectRow.remove();
            
            if (isCorrect) {
                if (optionRow) {
                    optionRow.classList.add('correct-highlight');
                    optionRow.classList.remove('wrong-highlight');
                }
                if (input) {
                    input.style.border = 'none';
                    input.style.backgroundColor = '#e8f5e9';
                }
                if (statusSpan) statusSpan.style.display = 'none';
                
                const oldExplainIcon = qElement?.querySelector('.explain-icon');
                if (oldExplainIcon) oldExplainIcon.remove();
                
                const existingAnswerRow = qElement?.querySelector('.correct-answer-text-row');
                if (existingAnswerRow) existingAnswerRow.remove();
                
                const currentValue = input ? input.value : '';
                if (input) input.value = '';
                
                const inputContent = document.createElement('div');
                inputContent.style.display = 'flex';
                inputContent.style.alignItems = 'center';
                inputContent.style.gap = '12px';
                inputContent.style.width = '100%';
                
                const answerText = document.createElement('span');
                answerText.style.color = '#2e7d32';
                answerText.innerHTML = escapeHtml(currentValue);
                
                const iconContainer = document.createElement('div');
                iconContainer.style.display = 'flex';
                iconContainer.style.alignItems = 'center';
                iconContainer.style.gap = '12px';
                
                const statusIcon = document.createElement('span');
                statusIcon.style.color = '#2e7d32';
                statusIcon.style.fontWeight = 'bold';
                statusIcon.innerHTML = '✓';
                
                const lightIcon = document.createElement('button');
                lightIcon.className = 'explain-icon';
                lightIcon.setAttribute('data-qid', q.id);
                lightIcon.style.cssText = 'background: none; border: none; cursor: pointer; color: #f59e0b; font-size: 14px; padding: 0;';
                lightIcon.innerHTML = '<i class="fas fa-lightbulb"></i>';
                lightIcon.onclick = (e) => {
                    e.stopPropagation();
                    const explainArea = document.querySelector(`.explanation-area[data-explain="${q.id}"]`);
                    if (explainArea) explainArea.classList.toggle('show');
                };
                
                iconContainer.appendChild(statusIcon);
                iconContainer.appendChild(lightIcon);
                inputContent.appendChild(answerText);
                inputContent.appendChild(iconContainer);
                
                if (input) {
                    input.style.display = 'none';
                    const parent = input.parentNode;
                    inputContent.setAttribute('data-input-id', q.id);
                    parent.appendChild(inputContent);
                }
            } else {
                const userAnswerText = userAns || '';
                let correctDisplay = '';
                if (Array.isArray(correctAnswer)) {
                    correctDisplay = correctAnswer.join(' / ');
                } else {
                    correctDisplay = correctAnswer;
                }
                
                if (optionRow) {
                    optionRow.classList.remove('correct-highlight', 'wrong-highlight');
                }
                if (input) input.style.display = 'none';
                if (statusSpan) statusSpan.style.display = 'none';
                
                const userRow = document.createElement('div');
                userRow.className = 'user-answer-row';
                userRow.style.cssText = `margin-top: 4px; margin-left: 28px; padding: 8px 12px; background-color: #ffebee; border-radius: 8px; display: flex; align-items: center; gap: 12px; font-size: 14px;`;
                const userText = document.createElement('div');
                userText.style.cssText = `color: #d32f2f;`;
                userText.innerHTML = `<strong>   </strong> ${escapeHtml(userAnswerText)}`;
                const userStatus = document.createElement('span');
                userStatus.style.cssText = `color: #d32f2f; font-weight: bold;`;
                userStatus.innerHTML = '✗';
                userRow.appendChild(userText);
                userRow.appendChild(userStatus);
                
                const correctRow = document.createElement('div');
                correctRow.className = 'correct-answer-row';
                correctRow.style.cssText = `margin-top: 4px; margin-left: 28px; padding: 8px 12px; background-color: #e8f5e9; border-radius: 8px; display: flex; align-items: center; gap: 12px; font-size: 14px;`;
                const answerText = document.createElement('div');
                answerText.style.cssText = `color: #2e7d32;`;
                answerText.innerHTML = `<strong>   正確答案：</strong> ${escapeHtml(correctDisplay)}`;
                
                const correctStatusContainer = document.createElement('div');
                correctStatusContainer.style.cssText = `display: flex; align-items: center; gap: 8px;`;
                const correctStatus = document.createElement('span');
                correctStatus.style.cssText = `color: #2e7d32; font-weight: bold;`;
                correctStatus.innerHTML = '✓';
                const explainIcon = document.createElement('button');
                explainIcon.className = 'explain-icon';
                explainIcon.setAttribute('data-qid', q.id);
                explainIcon.style.cssText = `background: none; border: none; cursor: pointer; color: #f59e0b; font-size: 14px; padding: 0;`;
                explainIcon.innerHTML = '<i class="fas fa-lightbulb"></i>';
                explainIcon.onclick = (e) => {
                    e.stopPropagation();
                    const explainArea = document.querySelector(`.explanation-area[data-explain="${q.id}"]`);
                    if (explainArea) explainArea.classList.toggle('show');
                };
                
                correctStatusContainer.appendChild(correctStatus);
                correctStatusContainer.appendChild(explainIcon);
                correctRow.appendChild(answerText);
                correctRow.appendChild(correctStatusContainer);
                
                const existingUserRow = qElement?.querySelector('.user-answer-row');
                if (existingUserRow) existingUserRow.remove();
                const existingCorrectRow2 = qElement?.querySelector('.correct-answer-row');
                if (existingCorrectRow2) existingCorrectRow2.remove();
                
                const optionsDiv = qElement?.querySelector('.options');
                if (optionsDiv) {
                    optionsDiv.after(userRow);
                    userRow.after(correctRow);
                }
            }
        } else {
            isCorrect = (userAns === q.answer);
        }
        
        if (isCorrect) score++;
        
        const optionDivs = document.querySelectorAll(`.question-item[data-qid="${q.id}"] .option-row`);
        optionDivs.forEach(div => {
            const letter = div.dataset.letter;
            const statusSpan = div.querySelector('.option-status');
            const explainBtn = div.querySelector('.explain-icon');
            
            if ((Array.isArray(q.answer) && q.answer.includes(letter)) || letter === q.answer) {
                div.classList.add('correct-highlight');
                if (statusSpan) {
                    statusSpan.style.display = 'inline';
                    statusSpan.innerHTML = ' ✓';
                    statusSpan.style.color = '#2e7d32';
                }
                if (explainBtn) explainBtn.style.display = 'inline-flex';
            }
            
            if (userAns && (
                (Array.isArray(userAns) && userAns.includes(letter) && !(Array.isArray(q.answer) && q.answer.includes(letter))) ||
                (userAns === letter && userAns !== q.answer && q.type !== 'fill')
            )) {
                div.classList.add('wrong-highlight');
                if (statusSpan) {
                    statusSpan.style.display = 'inline';
                    statusSpan.innerHTML = ' ✗';
                    statusSpan.style.color = '#d32f2f';
                }
            }
        });
    });
    
    const percentage = Math.round((score / total) * 100);
    const scoreDisplay = document.getElementById('scoreDisplay');
    if (scoreDisplay) {
        scoreDisplay.innerHTML = `📊 得分: ${score} / ${total} (${percentage}%)`;
    }
    
    const existingProgress = userProgress[practiceId];
    const bestPercentage = existingProgress?.percentage || 0;
    const finalPercentage = Math.max(percentage, bestPercentage);
    const finalBadge = finalPercentage >= BADGE_THRESHOLD ? '🎖️' : (finalPercentage >= PASS_THRESHOLD ? '✓' : null);
    
    let bestScore = existingProgress?.score || 0;
    let bestTotal = existingProgress?.total || total;
    if (percentage > bestPercentage) {
        bestScore = score;
        bestTotal = total;
    }
    
    userProgress[practiceId] = { 
        percentage: finalPercentage, 
        badge: finalBadge, 
        score: bestScore, 
        total: bestTotal,
        lastAttempt: new Date().toISOString()
    };
    StorageManager.saveProgress(userProgress);
    
    if (finalBadge === '🎖️' && (bestPercentage < BADGE_THRESHOLD || !existingProgress)) {
        showToast(`🎉 恭喜獲得徽章！ ${currentPracticeData.title} 正確率 ${finalPercentage}%`, 'success');
    } else if (percentage > bestPercentage) {
        showToast(`📈 進步了！正確率 ${percentage}% (最佳: ${finalPercentage}%)`, 'success');
    }
    
    syncProgressToCloud(practiceId, finalPercentage, finalBadge, bestScore, bestTotal);
    
    if (currentUser && !currentUser.isAnonymous && !isGuestMode) {
        debouncedUpdateStats(currentUser.uid, userProgress);
    }
    
    updateSidebarBadges();
}

async function syncProgressToCloud(practiceId, percentage, badge, score, total) {
    if (!currentUser || currentUser.isAnonymous || isGuestMode) return;
    try {
        const progressRef = doc(db, 'users', currentUser.uid);
        const progressKey = `progress.${practiceId}`;
        const progressData = { percentage, badge, score, total, lastAttempt: new Date().toISOString() };
        await updateDoc(progressRef, {
            [progressKey]: progressData,
            totalScore: increment(percentage - (userProgress[practiceId]?.percentage || 0)),
            updatedAt: new Date().toISOString()
        });
        userProgress[practiceId] = progressData;
        const badgesCount = Object.values(userProgress).filter(p => p.badge === '🎖️').length;
        if (badgesCount !== currentUserData?.badgesEarned) {
            await updateDoc(progressRef, { badgesEarned: badgesCount });
            if (currentUserData) currentUserData.badgesEarned = badgesCount;
        }
        console.log(`✅ 進度已同步: ${practiceId} = ${percentage}%`);
    } catch (error) {
        console.error('同步進度失敗:', error);
    }
}

// ==================== 懸浮視窗控制 ====================
function updateFloatingDisplay() {
    if (!segments.length) return;
    const seg = segments[currentSegmentIndex];
    const roleText = roleNames[seg.role] || roleNames.default;
    const roleIcon = roleIcons[seg.role] || roleIcons.default;
    const roleElement = document.getElementById('floatRole');
    const textElement = document.getElementById('floatText');
    if (roleElement) roleElement.innerHTML = `<i class="fas ${roleIcon}"></i> ${roleText}`;
    if (textElement) textElement.textContent = seg.text;
    if (seg.translation) {
        const translationText = document.getElementById('floatTranslationText');
        if (translationText) translationText.textContent = seg.translation;
    }
    
    const floatingPlayer = document.getElementById('floatingPlayer');
    const englishDiv = document.getElementById('floatingEnglish');
    const chineseDiv = document.getElementById('floatingChinese');
    
    if (isTextHidden) {
        englishDiv?.classList.add('hidden');
        chineseDiv?.classList.add('hidden');
    } else {
        englishDiv?.classList.remove('hidden');
        if (chineseDiv) {
            chineseDiv.classList.remove('hidden');
            chineseDiv.style.display = isTranslationHidden ? 'none' : 'block';
        }
    }
    
    if (!isMinimized && isTextHidden) {
        floatingPlayer.classList.add('control-minimized');
        floatingPlayer.style.width = '280px';
    } else {
        floatingPlayer.classList.remove('control-minimized');
        if (userWidth && !isMinimized && !isTextHidden) {
            floatingPlayer.style.width = userWidth;
        }
    }
}

function applyStoredSize() {
    const floatingPlayer = document.getElementById('floatingPlayer');
    if (!floatingPlayer) return;
    if (userWidth) floatingPlayer.style.width = userWidth;
    if (userHeight && !isTextHidden && !isMinimized) {
        floatingPlayer.style.height = userHeight;
    }
}

function loadStoredSize() {
    const savedWidth = localStorage.getItem('floatingPlayerWidth');
    const savedHeight = localStorage.getItem('floatingPlayerHeight');
    if (savedWidth) userWidth = savedWidth;
    if (savedHeight) userHeight = savedHeight;
    applyStoredSize();
}

function enterNormalMode() {
    const floatingPlayer = document.getElementById('floatingPlayer');
    if (!floatingPlayer) return;
    
    isMinimized = false;
    floatingPlayer.classList.remove('minimized');
    floatingPlayer.classList.remove('control-minimized');
    
    if (userWidth) floatingPlayer.style.width = userWidth;
    if (userHeight) floatingPlayer.style.height = userHeight;
    
    if (isTextHidden) {
        isTextHidden = false;
        const toggleTextBtn = document.getElementById('toggleTextBtn');
        if (toggleTextBtn) {
            toggleTextBtn.innerHTML = '<i class="fas fa-font"></i>';
            toggleTextBtn.title = '隱藏文字 (盲聽模式)';
        }
    }
    
    updateFloatingDisplay();
    saveFloatingState();
}

function enterControlMinimized() {
    const floatingPlayer = document.getElementById('floatingPlayer');
    if (!floatingPlayer) return;
    
    isMinimized = false;
    floatingPlayer.classList.remove('minimized');
    floatingPlayer.classList.add('control-minimized');
    floatingPlayer.style.width = '280px';
    
    if (!isTextHidden) {
        isTextHidden = true;
        const toggleTextBtn = document.getElementById('toggleTextBtn');
        if (toggleTextBtn) {
            toggleTextBtn.innerHTML = '<i class="fas fa-eye"></i>';
            toggleTextBtn.title = '顯示文字';
        }
    }
    
    updateFloatingDisplay();
    saveFloatingState();
}

function enterDotMinimized() {
    const floatingPlayer = document.getElementById('floatingPlayer');
    if (!floatingPlayer) return;
    
    isMinimized = true;
    floatingPlayer.classList.add('minimized');
    floatingPlayer.classList.remove('control-minimized');
    updateFloatingDisplay();
    saveFloatingState();
}

function saveFloatingState() {
    const floatingPlayer = document.getElementById('floatingPlayer');
    if (!floatingPlayer) return;
    try {
        const state = {
            left: floatingPlayer.style.left,
            top: floatingPlayer.style.top,
            width: floatingPlayer.style.width,
            isTextHidden: isTextHidden,
            isTranslationHidden: isTranslationHidden,
            isMinimized: isMinimized
        };
        localStorage.setItem('floatingPlayerState', JSON.stringify(state));
    } catch(e) {}
}

function loadFloatingState() {
    try {
        const saved = localStorage.getItem('floatingPlayerState');
        if (saved) {
            const state = JSON.parse(saved);
            const floatingPlayer = document.getElementById('floatingPlayer');
            if (state.left && state.top && floatingPlayer) {
                floatingPlayer.style.left = state.left;
                floatingPlayer.style.top = state.top;
                floatingPlayer.style.right = 'auto';
                floatingPlayer.style.bottom = 'auto';
            }
            if (state.width && floatingPlayer) floatingPlayer.style.width = state.width;
            if (state.isTextHidden !== undefined) isTextHidden = state.isTextHidden;
            if (state.isTranslationHidden !== undefined) isTranslationHidden = state.isTranslationHidden;
            if (state.isMinimized !== undefined) {
                isMinimized = state.isMinimized;
                if (floatingPlayer) {
                    if (isMinimized) floatingPlayer.classList.add('minimized');
                    else floatingPlayer.classList.remove('minimized');
                }
            }
            updateFloatingDisplay();
        }
    } catch(e) {}
}

function initFloatingControls() {
    const floatingPlayer = document.getElementById('floatingPlayer');
    const floatingHeader = document.getElementById('floatingHeader');
    if (!floatingPlayer) return;
    
    loadStoredSize();
    
    let isDragging = false;
    let dragStartX, dragStartY, playerStartX, playerStartY;
    let startMouseX, startMouseY;
    
    floatingHeader.addEventListener('mousedown', (e) => {
        if (e.target.closest('.floating-header-btns')) return;
        isDragging = true;
        startMouseX = e.clientX;
        startMouseY = e.clientY;
        const rect = floatingPlayer.getBoundingClientRect();
        dragStartX = e.clientX - rect.left;
        dragStartY = e.clientY - rect.top;
        playerStartX = rect.left;
        playerStartY = rect.top;
        floatingPlayer.style.left = playerStartX + 'px';
        floatingPlayer.style.top = playerStartY + 'px';
        floatingPlayer.style.right = 'auto';
        floatingPlayer.style.bottom = 'auto';
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        let newLeft = e.clientX - dragStartX;
        let newTop = e.clientY - dragStartY;
        newLeft = Math.max(0, Math.min(window.innerWidth - floatingPlayer.offsetWidth, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - floatingPlayer.offsetHeight, newTop));
        floatingPlayer.style.left = newLeft + 'px';
        floatingPlayer.style.top = newTop + 'px';
    });
    
    document.addEventListener('mouseup', (e) => {
        if (isDragging) {
            isDragging = false;
            let movedX = Math.abs(e.clientX - startMouseX);
            let movedY = Math.abs(e.clientY - startMouseY);
            if (movedX <= 3 && movedY <= 3 && isMinimized) enterNormalMode();
            saveFloatingState();
        }
    });
    
    const resizeHandle = document.getElementById('resizeHandle');
    if (resizeHandle) {
        let isResizing = false;
        let startWidth, startHeight, startX, startY;
        
        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startWidth = floatingPlayer.offsetWidth;
            startHeight = floatingPlayer.offsetHeight;
            startX = e.clientX;
            startY = e.clientY;
            e.preventDefault();
            e.stopPropagation();
            document.body.style.userSelect = 'none';
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            let deltaX = e.clientX - startX;
            let deltaY = e.clientY - startY;
            let newWidth = startWidth + deltaX;
            let newHeight = startHeight + deltaY;
            newWidth = Math.min(550, Math.max(280, newWidth));
            newHeight = Math.min(500, Math.max(200, newHeight));
            floatingPlayer.style.width = newWidth + 'px';
            floatingPlayer.style.height = newHeight + 'px';
            userWidth = newWidth + 'px';
            userHeight = newHeight + 'px';
            localStorage.setItem('floatingPlayerWidth', userWidth);
            localStorage.setItem('floatingPlayerHeight', userHeight);
        });
        
        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.userSelect = '';
                saveFloatingState();
            }
        });
    }
    
    const toggleTextBtn = document.getElementById('toggleTextBtn');
    if (toggleTextBtn) {
        toggleTextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isMinimized) return;
            if (isTextHidden) enterNormalMode();
            else enterControlMinimized();
            saveFloatingState();
        });
    }
    
    const toggleTranslationBtn = document.getElementById('toggleTranslationBtn');
    if (toggleTranslationBtn) {
        toggleTranslationBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isMinimized || isTextHidden) return;
            isTranslationHidden = !isTranslationHidden;
            const chineseDiv = document.getElementById('floatingChinese');
            if (chineseDiv) chineseDiv.style.display = isTranslationHidden ? 'none' : 'block';
            toggleTranslationBtn.innerHTML = isTranslationHidden ? '<i class="fas fa-language"></i>' : '<i class="fas fa-language" style="background: rgba(255,255,255,0.4);"></i>';
            saveFloatingState();
        });
    }
    
    const minimizeBtn = document.getElementById('minimizeFloatBtn');
    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isMinimized) enterNormalMode();
            else enterDotMinimized();
            saveFloatingState();
        });
    }
    
    const floatPlayBtn = document.getElementById('floatPlayBtn');
    const floatPrevBtn = document.getElementById('floatPrevBtn');
    const floatNextBtn = document.getElementById('floatNextBtn');
    if (floatPlayBtn) floatPlayBtn.onclick = () => togglePlayPause();
    if (floatPrevBtn) floatPrevBtn.onclick = () => prevSegment();
    if (floatNextBtn) floatNextBtn.onclick = () => nextSegment();
    
    loadFloatingState();
}

// ==================== 初始化 ====================
async function init() {
    if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        registrations.forEach(reg => reg.unregister());
        console.log('🗑️ 已清除舊的 Service Worker');
    }
    
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            currentUser = user;
            isGuestMode = user.isAnonymous || false;
            
            if (unsubscribeUserListener) {
                unsubscribeUserListener();
                unsubscribeUserListener = null;
            }
            
            const userRef = doc(db, 'users', user.uid);
            
            if (onlineStatusInterval) clearInterval(onlineStatusInterval);
            updateLastActive();
            onlineStatusInterval = setInterval(updateLastActive, ONLINE_STATUS_INTERVAL);
            
            const userSnap = await getDoc(userRef);
            if (userSnap.exists()) {
                currentUserData = userSnap.data();
                
                if (currentUserData.isDisabled === true) {
                    console.log('🚫 帳號已被停用，強制登出');
                    if (onlineStatusInterval) clearInterval(onlineStatusInterval);
                    await signOut(auth);
                    alert('您的帳號已被管理員停用，請聯絡客服。');
                    window.location.href = './login.html';
                    return;
                }
                
                userProgress = currentUserData.progress || {};
                StorageManager.saveProgress(userProgress);
                
                let needsSave = false;
                for (const [id, value] of Object.entries(userProgress)) {
                    if (typeof value === 'number') {
                        const percentage = value;
                        const badge = percentage >= BADGE_THRESHOLD ? '🎖️' : (percentage >= PASS_THRESHOLD ? '✓' : null);
                        userProgress[id] = { percentage, badge, score: null, total: null, lastAttempt: null };
                        needsSave = true;
                    } else if (value && !value.lastAttempt) {
                        userProgress[id].lastAttempt = null;
                        needsSave = true;
                    }
                }
                if (needsSave) {
                    StorageManager.saveProgress(userProgress);
                    for (const [id, data] of Object.entries(userProgress)) {
                        syncProgressToCloud(id, data.percentage, data.badge, data.score, data.total);
                    }
                }
                
                await updateDoc(userRef, {
                    lastLoginAt: new Date().toISOString(),
                    loginCount: increment(1)
                });
                currentUserGrade = currentUserData.grade || null;
                
            } else {
                await setDoc(userRef, {
                    email: user.email || null,
                    displayName: user.displayName || (user.isAnonymous ? '訪客' : ''),
                    createdAt: new Date().toISOString(),
                    lastLoginAt: new Date().toISOString(),
                    loginCount: 1,
                    progress: {},
                    stats: {
                        totalPractices: 0,
                        avgPercentage: 0,
                        badges: { gold: 0, pass: 0 }
                    },
                    totalScore: 0,
                    badgesEarned: 0,
                    premium: false,
                    isGuest: user.isAnonymous || false,
                    publishers: ["Open示範"]
                });
                currentUserData = {
                    email: user.email || null,
                    displayName: user.displayName || (user.isAnonymous ? '訪客' : ''),
                    progress: {},
                    stats: {
                        totalPractices: 0,
                        avgPercentage: 0,
                        badges: { gold: 0, pass: 0 }
                    },
                    totalScore: 0,
                    badgesEarned: 0,
                    premium: false,
                    isGuest: user.isAnonymous || false,
                    publishers: ["Open示範"]
                };
                userProgress = {};
                StorageManager.saveProgress(userProgress);
                currentUserGrade = null;
            }
            
            unsubscribeUserListener = onSnapshot(userRef, (docSnap) => {
                if (docSnap.exists()) {
                    const newData = docSnap.data();
                    if (newData.isDisabled === true) {
                        console.log('🚫 帳號已被管理員停用，強制登出');
                        if (unsubscribeUserListener) unsubscribeUserListener();
                        if (onlineStatusInterval) clearInterval(onlineStatusInterval);
                        signOut(auth);
                        alert('您的帳號已被管理員停用，請聯絡客服。');
                        window.location.href = './login.html';
                        return;
                    }
                    
                    const oldGrade = currentUserGrade;
                    currentUserData = newData;
                    currentUserGrade = newData.grade || null;
                    
                    if (oldGrade !== currentUserGrade) {
                        if (unitsIndex.units && unitsIndex.units.length > 0) {
                            renderSidebar();
                            const availableUnits = filterUnitsByUser(unitsIndex.units);
                            if (availableUnits.length > 0) {
                                const floatingPlayer = document.getElementById('floatingPlayer');
                                if (floatingPlayer) floatingPlayer.style.display = '';
                                loadUnit(availableUnits[0].id);
                            } else {
                                showNoMaterialMessage();
                            }
                        }
                    }
                }
            });
            
            updateUserInterface();
            await loadUnitsIndex();
            await loadSystemConfig();
            renderSidebar();
            initFloatingControls();
            
            if (unitsIndex.units && unitsIndex.units.length > 0) {
                let availableUnits = filterUnitsByUser(unitsIndex.units);
                if (availableUnits.length > 0) {
                    await loadUnit(availableUnits[0].id);
                } else {
                    showNoMaterialMessage();
                }
            }
            
            const checkBtn = document.getElementById('checkBtn');
            const resetBtn = document.getElementById('resetBtn');
            if (checkBtn) checkBtn.onclick = checkAllAnswers;
            if (resetBtn) resetBtn.onclick = resetCurrentPractice;
            
        } else {
            window.location.href = './login.html';
        }
    });
}

window.checkAllAnswers = checkAllAnswers;
window.resetCurrentPractice = resetCurrentPractice;
window.loadUnit = loadUnit;

window.addEventListener('load', init);