const API_BASE = window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1') 
    ? '' 
    : 'http://127.0.0.1:8765';

let allGames = [];
let currentGame = null;
let isTranslated = false;
let originalMetadata = null;
let lastGridScrollPos = 0;
let appSettings = null;

function renderTranslateButtonLabel(mode = 'translate') {
    const label = mode === 'revert' ? 'Revert' : 'Translate';
    return `<i data-lucide="languages" style="width:14px;height:14px;"></i><span>${label}</span>`;
}

function normalizeRatingText(value) {
    if (!value) return 'N/A';
    return String(value)
        .replace(/(\d+(?:\.\d+)?)\s*[^\w\s\/().,-]{1,6}\s*\(([^)]+)\)/g, '$1 / 5 ($2)')
        .replace(/(\d+(?:\.\d+)?)\s*[^\w\s\/().,-]{1,6}$/g, '$1 / 5');
}


// Filter States
let filterState = {
    preset: 'all',
    progress: 'all',
    updates: 'all',
    tag: 'all',
    source: 'all',
    search: '',
    sort: 'title'
};

document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

function activateTab(tabId) {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view-panel').forEach(v => v.classList.remove('active'));

    const activeTab = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
    const activeView = document.getElementById(`view-${tabId}`);
    if (!activeTab || !activeView) return;

    activeTab.classList.add('active');
    activeView.classList.add('active');

    if (tabId === 'library') loadGames();
    if (tabId === 'extension' && typeof loadExtensionQueue === 'function') loadExtensionQueue();
}

async function initApp() {
    setupEventListeners();
    const statsTask = fetchStats();
    const settingsTask = loadSettings();
    const tagsTask = fetchTags();
    const gamesTask = loadGames();
    await Promise.allSettled([statsTask, settingsTask]);
    
    // Dismiss Splash Screen
    const splash = document.getElementById('app-splash');
    if (splash) {
        const statusEl = document.getElementById('splash-status');
        if (statusEl) statusEl.textContent = "Library loaded!";
        setTimeout(() => {
            splash.style.opacity = '0';
            splash.style.visibility = 'hidden';
            setTimeout(() => splash.remove(), 500);
        }, 300);
    }
    
    await Promise.allSettled([tagsTask, gamesTask]);
    await checkExtensionStatus();
    setInterval(checkExtensionStatus, 15000);
}

async function checkExtensionStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/extension/status`);
        const status = await res.json();
        
        const pill = document.getElementById('ext-status-pill');
        const dot = document.getElementById('ext-status-dot');
        const label = document.getElementById('ext-status-label');
        
        const banner = document.getElementById('ext-banner-box');
        const bTitle = document.getElementById('ext-banner-title');
        const bDesc = document.getElementById('ext-banner-desc');
        if (status.connected || status.status === 'connected') {
            if (pill) pill.className = 'quick-status ext-pill connected';
            if (dot) dot.className = 'status-dot';
            if (label) label.textContent = `Extension Connected (v${status.version || '1.0'})`;
            if (banner) banner.style.display = 'none';
        } else {
            if (pill) pill.className = 'quick-status ext-pill offline';
            if (dot) dot.className = 'status-dot offline';
            if (label) label.textContent = 'Extension Offline';
            if (banner) {
                banner.style.display = 'flex';
                banner.className = 'ext-status-banner offline';
                if (bTitle) bTitle.textContent = 'Chrome Companion Offline';
                if (bDesc) bDesc.textContent = `No heartbeat received from Chrome. Open Chrome and make sure the extension is loaded from your application's extension folder.`;
            }
        }

    } catch (e) {
        console.debug("Extension status check failed", e);
    }
}

function setupEventListeners() {
    // Title Bar Dragging & Snapping (Win32 HTCAPTION via pywebview)
    const topNav = document.querySelector('.top-nav');
    if (topNav) {
        topNav.addEventListener('mousedown', (e) => {
            if (e.button === 0 && !e.target.closest('button, nav, input, select, .quick-status, .window-controls')) {
                if (window.pywebview && pywebview.api && pywebview.api.start_drag) {
                    pywebview.api.start_drag();
                }
            }
        });
    }

    // Navigation Tabs
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            activateTab(tab.dataset.tab);
        });
    });

    const homeLogoBtn = document.getElementById('btn-home-logo');
    if (homeLogoBtn) {
        homeLogoBtn.addEventListener('click', () => {
            activateTab('library');
        });
    }

    // Quick Scan / Add Game button
    const btnAddGame = document.getElementById('btn-add-game');
    if (btnAddGame) btnAddGame.addEventListener('click', (e) => triggerRescan(e.currentTarget));
    
    // Window Controls (Minimize, Maximize, Close)
    const btnWinMin = document.getElementById('btn-win-min');
    if (btnWinMin) btnWinMin.addEventListener('click', async () => {
        if (window.pywebview && pywebview.api && pywebview.api.minimize) pywebview.api.minimize();
        else await fetch(`${API_BASE}/api/window/minimize`, { method: 'POST' }).catch(() => {});
    });
    const btnWinMax = document.getElementById('btn-win-max');
    if (btnWinMax) btnWinMax.addEventListener('click', async () => {
        if (window.pywebview && pywebview.api && pywebview.api.maximize) pywebview.api.maximize();
        else await fetch(`${API_BASE}/api/window/maximize`, { method: 'POST' }).catch(() => {});
    });
    const btnWinClose = document.getElementById('btn-win-close');
    if (btnWinClose) btnWinClose.addEventListener('click', async () => {
        if (window.pywebview && pywebview.api && pywebview.api.close) pywebview.api.close();
        else await fetch(`${API_BASE}/api/window/close`, { method: 'POST' }).catch(() => {});
    });
    
    // Add to Wishlist
    const addWishBtn = document.getElementById('btn-add-wishlist');
    if (addWishBtn) {
        addWishBtn.addEventListener('click', async () => {
            const url = prompt("Enter game URL (F95Zone, DLsite, Itch.io, or Steam) to add to Wishlist:");
            if (!url) return;
            const originalText = addWishBtn.innerHTML;
            try {
                addWishBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Adding...</span>`;
                addWishBtn.disabled = true;
                if (window.lucide) lucide.createIcons();
                
                const res = await fetch(`${API_BASE}/api/games/wishlist`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({url})
                });
                if (res.ok) {
                    alert("Added to Wishlist instantly! Cover and metadata are downloading in the background.");
                    loadGames();
                    fetchStats();
                } else {
                    const data = await res.json();
                    alert(data.detail || "Failed to add to wishlist.");
                }
            } catch(e) {
                alert("Network error while adding to wishlist.");
            } finally {
                addWishBtn.innerHTML = originalText;
                addWishBtn.disabled = false;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    // Onboarding & Tutorial controls
    document.getElementById('btn-show-tutorial')?.addEventListener('click', () => {
        const modal = document.getElementById('onboarding-modal');
        if (modal) modal.style.display = 'flex';
    });
    document.getElementById('btn-close-onboarding')?.addEventListener('click', () => {
        localStorage.setItem('xdir_onboarding_completed', 'true');
        const modal = document.getElementById('onboarding-modal');
        if (modal) modal.style.display = 'none';
    });
    document.getElementById('btn-onboarding-got-it')?.addEventListener('click', () => {
        localStorage.setItem('xdir_onboarding_completed', 'true');
        const modal = document.getElementById('onboarding-modal');
        if (modal) modal.style.display = 'none';
    });

    // Settings Primary Game Setups Directory controls
    document.getElementById('btn-browse-dir')?.addEventListener('click', async () => {
        if (window.pywebview && window.pywebview.api && window.pywebview.api.browse_folder) {
            const currentVal = document.getElementById('setting-games-dir').value;
            const chosen = await window.pywebview.api.browse_folder(currentVal);
            if (chosen) {
                document.getElementById('setting-games-dir').value = chosen;
            }
        } else {
            alert("Please enter or paste your desired folder path directly into the input box!");
        }
    });

    document.getElementById('btn-save-preferences')?.addEventListener('click', async () => {
        await persistSettings();
    });

    // Filter Cards in Sidebar
    const filterAvailCard = document.getElementById('filter-available-card');
    if (filterAvailCard) {
        filterAvailCard.addEventListener('click', () => {
            const presetSelect = document.getElementById('filter-preset');
            if (presetSelect) presetSelect.value = 'available';
            filterState.preset = 'available';
            
            const updatesSelect = document.getElementById('filter-updates');
            if (updatesSelect) updatesSelect.value = 'all';
            filterState.updates = 'all';
            
            loadGames();
        });
    }

    const filterWishCard = document.getElementById('filter-wishlist-card');
    if (filterWishCard) {
        filterWishCard.addEventListener('click', () => {
            const updatesSelect = document.getElementById('filter-updates');
            if (updatesSelect) updatesSelect.value = 'wishlist';
            filterState.updates = 'wishlist';
            loadGames();
        });
    }

    // Left Filter Sidebar Selects
    ['preset', 'progress', 'updates', 'tag', 'source'].forEach(key => {
        const el = document.getElementById(`filter-${key}`);
        if (el) {
            el.addEventListener('change', (e) => {
                filterState[key] = e.target.value;
                loadGames();
            });
        }
    });

    // Search bar
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-search');
    let searchTimeout;
    
    searchInput.addEventListener('input', (e) => {
        filterState.search = e.target.value.trim();
        clearBtn.style.display = filterState.search ? 'block' : 'none';
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => loadGames(), 150);
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        filterState.search = '';
        clearBtn.style.display = 'none';
        loadGames();
    });

    // Sort select
    document.getElementById('sort-select').addEventListener('change', (e) => {
        filterState.sort = e.target.value;
        loadGames();
    });

    // Overview Back button
    document.getElementById('overview-back').addEventListener('click', async () => {
        document.getElementById('overview-modal').style.display = 'none';
        
        // Restore scroll position of the games grid
        const gridEl = document.getElementById('games-grid');
        const scrollPos = lastGridScrollPos || (gridEl ? gridEl.scrollTop : 0);
        if (gridEl) gridEl.scrollTop = scrollPos;
    });

    // Overview Launch button
    document.getElementById('ov-btn-launch').addEventListener('click', () => {
        if (currentGame) launchGame(currentGame.id);
    });

    document.getElementById('ov-btn-folder').addEventListener('click', () => {
        if (currentGame) launchGame(currentGame.id, true);
    });

    const updateBadgeBtn = document.getElementById('ov-badge-update');
    if (updateBadgeBtn) {
        updateBadgeBtn.addEventListener('click', () => {
            if (currentGame && currentGame.source_url) {
                window.open(currentGame.source_url, '_blank');
            } else if (currentGame) {
                window.open(`https://f95zone.to/search/search?keywords=${encodeURIComponent(currentGame.title)}`, '_blank');
            }
        });
    }

    // Overview Progress Selector
    document.getElementById('ov-progress-select').addEventListener('change', async (e) => {
        if (!currentGame) return;
        const newProg = e.target.value;
        try {
            await fetch(`${API_BASE}/api/games/${currentGame.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playing_progress: newProg })
            });
            currentGame.playing_progress = newProg;
        } catch (err) {
            console.error("Failed to update progress", err);
        }
    });

    // Overview User Star Rating Selector
    const starBtns = document.querySelectorAll('.user-star-btn');
    starBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!currentGame) return;
            const val = btn.getAttribute('data-val');
            const scoreStr = `${val}/5`;
            try {
                await fetch(`${API_BASE}/api/games/${currentGame.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_score: scoreStr })
                });
                currentGame.user_score = scoreStr;
                updateStarPickerUI(scoreStr);
                const gridCardScore = document.querySelector(`.game-card[data-id="${currentGame.id}"] .card-rating-box span:nth-child(2)`);
                if (gridCardScore && currentGame.user_score) gridCardScore.textContent = currentGame.user_score;
            } catch (err) {
                console.error("Failed to set user score", err);
            }
        });
    });

    const clearStarBtn = document.getElementById('ov-clear-star');
    if (clearStarBtn) {
        clearStarBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            try {
                await fetch(`${API_BASE}/api/games/${currentGame.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_score: '' })
                });
                currentGame.user_score = '';
                updateStarPickerUI('');
                const gridCardScore = document.querySelector(`.game-card[data-id="${currentGame.id}"] .card-rating-box span:nth-child(2)`);
                if (gridCardScore) gridCardScore.textContent = currentGame.rating || 'N/A';
            } catch (err) {
                console.error("Failed to clear user score", err);
            }
        });
    }

    // Custom Tag adder
    document.getElementById('ov-btn-add-tag').addEventListener('click', async () => {
        const input = document.getElementById('ov-new-tag-input');
        const tag = input.value.trim();
        if (!tag || !currentGame) return;
        
        try {
            const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/custom_tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag_name: tag })
            });
            currentGame = await res.json();
            input.value = '';
            renderOverview(currentGame);
            await fetchTags();
        } catch (err) {
            console.error("Failed to add custom tag", err);
        }
    });

    // Journal Entry adder
    document.getElementById('ov-btn-add-journal').addEventListener('click', async () => {
        const text = prompt("Enter game journal note or patch activity:");
        if (!text || !text.trim() || !currentGame) return;
        
        try {
            const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/journal`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entry_text: text.trim() })
            });
            currentGame = await res.json();
            renderOverview(currentGame);
        } catch (err) {
            console.error("Failed to add journal", err);
        }
    });

    // Settings Section Navigation
    document.querySelectorAll('.settings-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.set-panel').forEach(p => p.classList.remove('active'));
            
            btn.classList.add('active');
            const secId = btn.dataset.section;
            const target = document.getElementById(`set-${secId}`);
            if (target) target.classList.add('active');
        });
    });

    // Lightbox Close
    document.getElementById('lightbox-close').addEventListener('click', () => {
        document.getElementById('lightbox-modal').style.display = 'none';
    });

    // Per-game fetch info button
    const fetchBtn = document.getElementById('ov-btn-fetch');
    if (fetchBtn) {
        fetchBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            fetchBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Fetching...</span>`;
            if (window.lucide) lucide.createIcons();
            try {
                const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/fetch-metadata`, { method: 'POST' });
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || "Server error");
                }
                const data = await res.json();
                
                const wasIdentified = currentGame.is_identified;
                currentGame = data.game;
                renderOverview(currentGame);
                await fetchTags();
                await loadGames();
                
                if (!currentGame.is_identified) {
                    alert("Could not automatically find metadata for this game. If this is a DLsite game without an RJ code in its name, please use the Chrome Extension to sync it manually!");
                } else if (!wasIdentified && currentGame.is_identified) {
                    alert(`Successfully auto-identified as: ${currentGame.title}`);
                } else {
                    // It was already identified, just updated
                    alert("Metadata refreshed successfully!");
                }
            } catch (err) {
                alert("Failed to fetch information: " + err.message);
            } finally {
                fetchBtn.innerHTML = `<i data-lucide="download-cloud"></i> <span id="ov-fetch-text">Fetch Info</span>`;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    // Copy title button
    const copyTitleBtn = document.getElementById('ov-btn-copy-title');
    if (copyTitleBtn) {
        copyTitleBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            try {
                await navigator.clipboard.writeText(currentGame.title || currentGame.raw_name);
                const originalHTML = copyTitleBtn.innerHTML;
                copyTitleBtn.innerHTML = `<i data-lucide="check" style="width: 18px; height: 18px; color: var(--success);"></i>`;
                if (window.lucide) lucide.createIcons();
                setTimeout(() => {
                    copyTitleBtn.innerHTML = originalHTML;
                    if (window.lucide) lucide.createIcons();
                }, 1500);
            } catch (err) {
                console.error("Failed to copy", err);
            }
        });
    }

    // Translation Logic
    async function translateTextsBackend(texts) {
        try {
            const res = await fetch(`${API_BASE}/api/translate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ texts: texts })
            });
            const data = await res.json();
            return data.translations;
        } catch (err) {
            console.error("Translation failed", err);
            return texts;
        }
    }

    const translateBtn = document.getElementById('ov-btn-translate');
    if (translateBtn) {
        translateBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            
            if (isTranslated) {
                // Restore originals
                document.getElementById('ov-title-top').textContent = originalMetadata.title;
                document.getElementById('ov-title').textContent = originalMetadata.title;
                const descEl = document.getElementById('ov-description');
                if (descEl) descEl.textContent = originalMetadata.description || "No description available yet. Click above or use the companion extension to auto-scrape from F95zone or DLsite!";
                
                const tagsCloud = document.getElementById('ov-tag-cloud');
                if (tagsCloud) tagsCloud.innerHTML = originalMetadata.tagsHtml;
                
                isTranslated = false;
                translateBtn.innerHTML = renderTranslateButtonLabel('translate');
                translateBtn.style.color = '#93c5fd';
                return;
            }
            
            const origHtml = translateBtn.innerHTML;
            const origColor = translateBtn.style.color;
            try {
                translateBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Translating...</span>`;
                translateBtn.style.color = '#fbbf24';
                translateBtn.disabled = true;
                if (window.lucide) lucide.createIcons();
                
                // Save originals
                if (!originalMetadata) {
                    const tagsCloud = document.getElementById('ov-tag-cloud');
                    originalMetadata = {
                        title: currentGame.title || currentGame.raw_name,
                        description: currentGame.description,
                        tagsHtml: tagsCloud ? tagsCloud.innerHTML : ''
                    };
                }
                
                const allTags = [...(currentGame.tags || []), ...(currentGame.custom_tags || [])];
                const toTranslate = [originalMetadata.title, originalMetadata.description || '', ...allTags];
                
                const translated = await translateTextsBackend(toTranslate);
                if (!translated || translated.length === 0) {
                    throw new Error("Empty translation response");
                }
                
                const tTitle = translated[0];
                const tDesc = translated[1];
                const tTags = translated.slice(2);
                
                const tagsHtml = tTags.length > 0
                    ? tTags.map(t => `<span class="tag-chip">${t}</span>`).join('')
                    : `<span class="tag-chip">${currentGame.category || 'General'}</span>`;
                
                document.getElementById('ov-title-top').textContent = tTitle;
                document.getElementById('ov-title').textContent = tTitle;
                const descEl = document.getElementById('ov-description');
                if (descEl) descEl.textContent = tDesc || "No description available yet.";
                const tagsCloudEl = document.getElementById('ov-tag-cloud');
                if (tagsCloudEl) tagsCloudEl.innerHTML = tagsHtml;
                
                isTranslated = true;
                translateBtn.innerHTML = renderTranslateButtonLabel('revert');
                translateBtn.style.color = '#fca5a5';
            } catch (err) {
                console.error("Translation error:", err);
                alert("Translation failed. Please check your internet connection or try again!");
                translateBtn.innerHTML = origHtml;
                translateBtn.style.color = origColor;
            } finally {
                translateBtn.disabled = false;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    // Rename title button
    const editTitleBtn = document.getElementById('ov-btn-edit-title');
    if (editTitleBtn) {
        editTitleBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            const newTitle = prompt("Enter new title for this game:", currentGame.title || currentGame.raw_name);
            if (newTitle && newTitle.trim() !== "" && newTitle !== currentGame.title) {
                try {
                    const res = await fetch(`${API_BASE}/api/games/${currentGame.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title: newTitle.trim() })
                    });
                    if (res.ok) {
                        const updatedGame = await res.json();
                        currentGame.title = updatedGame.title;
                        document.getElementById('ov-title').textContent = currentGame.title;
                        loadGames(); // Refresh grid in background
                    }
                } catch(e) {
                    alert("Failed to update title.");
                }
            }
        });
    }

    // Per-game fetch description & metadata button inside Description section
    const fetchDescBtn = document.getElementById('ov-btn-fetch-desc');
    if (fetchDescBtn) {
        fetchDescBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            fetchDescBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Scraping...</span>`;
            fetchDescBtn.disabled = true;
            if (window.lucide) lucide.createIcons();
            try {
                const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/fetch-metadata`, { method: 'POST' });
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || "Server error");
                }
                const data = await res.json();
                
                const wasIdentified = currentGame.is_identified;
                currentGame = data.game;
                renderOverview(currentGame);
                await fetchTags();
                await loadGames();
                
                if (!currentGame.is_identified) {
                    alert("Could not automatically find metadata for this game. If this is a DLsite game without an RJ code in its name, please use the Chrome Extension to sync it manually!");
                } else if (!wasIdentified && currentGame.is_identified) {
                    alert(`Successfully auto-identified as: ${currentGame.title}`);
                }
            } catch (err) {
                alert("Failed to retrieve description and metadata: " + err.message);
            } finally {
                fetchDescBtn.disabled = false;
                fetchDescBtn.innerHTML = `<i data-lucide="zap" style="width:14px;height:14px;"></i> Retrieve Metadata & Description`;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    // Fix Titles & Refetch Metadata button in Settings -> Media
    const fixMetaBtn = document.getElementById('btn-fix-metadata');
    if (fixMetaBtn) {
        fixMetaBtn.addEventListener('click', async () => {
            fixMetaBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Fixing Titles & Refetching Metadata (Please wait)...</span>`;
            fixMetaBtn.disabled = true;
            if (window.lucide) lucide.createIcons();
            try {
                const res = await fetch(`${API_BASE}/api/library/fix-metadata`, { method: 'POST' });
                const data = await res.json();
                alert(data.message || "Metadata fix complete!");
                await fetchStats();
                await loadGames();
            } catch (err) {
                alert("Failed to fix titles and refetch metadata.");
            } finally {
                fixMetaBtn.disabled = false;
                fixMetaBtn.innerHTML = `<i data-lucide="wand-2"></i> <span>Fix Titles & Refetch All Metadata (Covers, Screenshots & Titles)</span>`;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    // F95zone Rematch button in Settings -> Media
    const rematchBtn = document.getElementById('btn-rematch-f95');
    if (rematchBtn) {
        rematchBtn.addEventListener('click', async () => {
            rematchBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Rematching and Scraping from F95Zone (Please wait)...</span>`;
            rematchBtn.disabled = true;
            if (window.lucide) lucide.createIcons();
            try {
                const res = await fetch(`${API_BASE}/api/library/rematch-f95zone`, { method: 'POST' });
                const data = await res.json();
                alert(data.message || "Rematching complete!");
                await fetchStats();
                await loadGames();
            } catch (err) {
                alert("Failed to rematch F95Zone titles.");
            } finally {
                rematchBtn.disabled = false;
                rematchBtn.innerHTML = `<i data-lucide="search"></i> <span>Rematch Unidentified Games from F95Zone</span>`;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    // === GAME SOURCE ACTION BUTTONS (in overlay) ===

    const ignoreBtn = document.getElementById('ov-btn-ignore');
    if (ignoreBtn) {
        ignoreBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            if (!confirm(`Are you sure you want to completely hide "${currentGame.title}" from your library? (This is useful for mods or junk folders)`)) return;
            
            try {
                const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/ignore`, {
                    method: 'PATCH',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({is_ignored: true})
                });
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || "Server error");
                }
                document.getElementById('overview-modal').style.display = 'none';
                loadGames();
                fetchStats();
            } catch (err) {
                alert("Failed to ignore game: " + err.message);
            }
        });
    }

    // 1. "Wrong Data / Re-scrape": Clears source and re-scrapes from F95Zone
    const markWrongBtn = document.getElementById('ov-btn-mark-wrong');
    if (markWrongBtn) {
        markWrongBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            if (!confirm(`Clear all scraped data for "${currentGame.title}" and re-scrape from F95Zone?`)) return;
            
            markWrongBtn.disabled = true;
            markWrongBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Clearing & re-scraping...</span>`;
            if (window.lucide) lucide.createIcons();
            
            try {
                // Step 1: Clear existing source data
                await fetch(`${API_BASE}/api/games/${currentGame.id}/clear-source`, { method: 'POST' });
                
                // Step 2: Re-scrape from F95Zone
                const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/fetch-metadata`, { method: 'POST' });
                const data = await res.json();
                currentGame = data.game;
                renderOverview(currentGame);
                await loadGames();
            } catch (err) {
                alert("Failed to re-scrape. You can try linking a source URL manually.");
            } finally {
                markWrongBtn.disabled = false;
                markWrongBtn.innerHTML = `<i data-lucide="alert-triangle"></i> <span>Wrong Data / Re-scrape</span>`;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    // 2. "Fetch from F95Zone": Force-fetch metadata via the F95Zone rematch engine
    const fetchF95Btn = document.getElementById('ov-btn-fetch-f95');
    if (fetchF95Btn) {
        fetchF95Btn.addEventListener('click', async () => {
            if (!currentGame) return;
            
            fetchF95Btn.disabled = true;
            fetchF95Btn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Searching F95Zone...</span>`;
            if (window.lucide) lucide.createIcons();
            
            try {
                const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/fetch-metadata`, { method: 'POST' });
                const data = await res.json();
                currentGame = data.game;
                renderOverview(currentGame);
                await loadGames();
            } catch (err) {
                alert("Failed to fetch from F95Zone. The game title may not be found - try linking a URL manually.");
            } finally {
                fetchF95Btn.disabled = false;
                fetchF95Btn.innerHTML = `<i data-lucide="search"></i><span style="font-size:0.8rem; font-weight:700;">F95Zone</span>`;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    const searchDlsiteBtn = document.getElementById('ov-btn-search-dlsite');
    if (searchDlsiteBtn) {
        searchDlsiteBtn.addEventListener('click', () => {
            if (!currentGame) return;
            const q = encodeURIComponent(currentGame.title || currentGame.raw_name);
            window.open(`https://www.google.com/search?q=site:dlsite.com+${q}`, '_blank');
        });
    }

    const searchItchBtn = document.getElementById('ov-btn-search-itch');
    if (searchItchBtn) {
        searchItchBtn.addEventListener('click', () => {
            if (!currentGame) return;
            const q = encodeURIComponent(currentGame.title || currentGame.raw_name);
            window.open(`https://www.google.com/search?q=site:itch.io+${q}`, '_blank');
        });
    }

    // 3. "Link Source URL": Toggle the manual URL input form
    const linkSourceBtn = document.getElementById('ov-btn-link-source');
    const linkForm = document.getElementById('ov-link-form');
    const cancelLinkBtn = document.getElementById('ov-btn-cancel-link');
    const submitLinkBtn = document.getElementById('ov-btn-submit-link');
    const linkInput = document.getElementById('ov-link-url-input');
    const localLinkBtn = document.getElementById('ov-btn-link-local');
    const localLinkForm = document.getElementById('ov-local-link-form');
    const localLinkSearch = document.getElementById('ov-local-link-search');
    const localLinkSelect = document.getElementById('ov-local-link-select');
    const cancelLocalLinkBtn = document.getElementById('ov-btn-cancel-local-link');
    const submitLocalLinkBtn = document.getElementById('ov-btn-submit-local-link');
    let localLinkSearchTimer = null;

    if (linkSourceBtn && linkForm) {
        linkSourceBtn.addEventListener('click', () => {
            if (localLinkForm) localLinkForm.style.display = 'none';
            linkForm.style.display = linkForm.style.display === 'none' ? 'block' : 'none';
            if (linkForm.style.display === 'block') {
                linkInput.value = '';
                linkInput.focus();
            }
        });
    }

    if (cancelLinkBtn && linkForm) {
        cancelLinkBtn.addEventListener('click', () => {
            linkForm.style.display = 'none';
            linkInput.value = '';
        });
    }

    if (submitLinkBtn) {
        submitLinkBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            const url = linkInput.value.trim();
            if (!url) { alert("Please paste a URL or DLsite code (e.g. RJ01234567)"); return; }

            submitLinkBtn.disabled = true;
            submitLinkBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Linking...</span>`;
            if (window.lucide) lucide.createIcons();

            try {
                const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/link`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ source_url: url })
                });
                
                if (!res.ok) {
                    const err = await res.json();
                    alert(err.detail || "Failed to link source.");
                    return;
                }
                
                const data = await res.json();
                currentGame = data.game;
                renderOverview(currentGame);
                await loadGames();
                linkForm.style.display = 'none';
                linkInput.value = '';
            } catch (err) {
                alert("Failed to link source. Check the URL and try again.");
            } finally {
                submitLinkBtn.disabled = false;
                submitLinkBtn.innerHTML = `<i data-lucide="check"></i> <span>Link & Fetch</span>`;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    async function loadWishlistLocalCandidates(searchValue = '') {
        if (!currentGame || currentGame.file_type !== 'wishlist' || !localLinkSelect) return;
        localLinkSelect.innerHTML = '<option value="">Loading local entries...</option>';
        try {
            const query = searchValue.trim()
                ? `?search=${encodeURIComponent(searchValue.trim())}`
                : '';
            const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/linkable-local${query}`);
            if (!res.ok) {
                throw new Error('Failed to load local link candidates');
            }
            const items = await res.json();
            if (!items.length) {
                localLinkSelect.innerHTML = '<option value="">No matching local entries found</option>';
                return;
            }
            localLinkSelect.innerHTML = items.map(item => {
                const pathTail = item.folder_path || '';
                const sourceLabel = item.source_type && item.source_type !== 'unknown'
                    ? ` | ${item.source_type.toUpperCase()}`
                    : '';
                return `<option value="${item.id}">${item.title} (${item.file_type.toUpperCase()})${sourceLabel} - ${pathTail}</option>`;
            }).join('');
        } catch (err) {
            localLinkSelect.innerHTML = '<option value="">Failed to load local entries</option>';
        }
    }

    if (localLinkBtn && localLinkForm) {
        localLinkBtn.addEventListener('click', async () => {
            if (linkForm) linkForm.style.display = 'none';
            const shouldShow = localLinkForm.style.display === 'none';
            localLinkForm.style.display = shouldShow ? 'block' : 'none';
            if (!shouldShow) return;
            if (localLinkSearch) localLinkSearch.value = currentGame?.title || '';
            await loadWishlistLocalCandidates(localLinkSearch?.value || currentGame?.title || '');
            if (localLinkSearch) localLinkSearch.focus();
        });
    }

    if (localLinkSearch) {
        localLinkSearch.addEventListener('input', () => {
            clearTimeout(localLinkSearchTimer);
            localLinkSearchTimer = setTimeout(() => {
                loadWishlistLocalCandidates(localLinkSearch.value || '');
            }, 180);
        });
    }

    if (cancelLocalLinkBtn && localLinkForm) {
        cancelLocalLinkBtn.addEventListener('click', () => {
            localLinkForm.style.display = 'none';
            if (localLinkSearch) localLinkSearch.value = '';
            if (localLinkSelect) localLinkSelect.innerHTML = '';
        });
    }

    if (submitLocalLinkBtn) {
        submitLocalLinkBtn.addEventListener('click', async () => {
            if (!currentGame || currentGame.file_type !== 'wishlist' || !localLinkSelect) return;
            const targetId = parseInt(localLinkSelect.value || '', 10);
            if (!targetId) {
                alert('Please select a scanned local entry to link.');
                return;
            }

            submitLocalLinkBtn.disabled = true;
            submitLocalLinkBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Linking...</span>`;
            if (window.lucide) lucide.createIcons();

            try {
                const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/link-local`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ target_game_id: targetId })
                });
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || 'Failed to link wishlist item to local entry');
                }
                const data = await res.json();
                currentGame = data.game;
                renderOverview(currentGame);
                await Promise.allSettled([loadGames(), fetchStats(), fetchTags()]);
                if (localLinkForm) localLinkForm.style.display = 'none';
                if (localLinkSearch) localLinkSearch.value = '';
                if (localLinkSelect) localLinkSelect.innerHTML = '';
            } catch (err) {
                alert(`Failed to link wishlist item: ${err.message}`);
            } finally {
                submitLocalLinkBtn.disabled = false;
                submitLocalLinkBtn.innerHTML = `<i data-lucide="link-2"></i> <span>Link Wishlist to Local Game</span>`;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    // Allow Enter key to submit link form
    if (linkInput) {
        linkInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && submitLinkBtn) {
                submitLinkBtn.click();
            }
        });
    }
}

async function triggerRescan(triggerButton = null) {
    const btn = triggerButton || document.getElementById('btn-add-game');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = `<i data-lucide="loader" class="spin"></i>`;
        btn.disabled = true;
    }
    if (window.lucide) lucide.createIcons();
    
    try {
        await fetch(`${API_BASE}/api/library/scan`, { method: 'POST' });
        await fetchStats();
        await fetchTags();
        await loadGames();
    } catch (err) {
        console.error("Scan failed", err);
    } finally {
        if (btn) {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
        if (window.lucide) lucide.createIcons();
    }
}

function collectSettingsPayload() {
    return {
        games_dir: document.getElementById('setting-games-dir')?.value.trim() || '',
        archive_mode: document.getElementById('set-launch-archive-mode')?.value || 'explorer',
        startup_scan: !!document.getElementById('toggle-startup-scan')?.checked,
        missing_grace_scans: parseInt(document.getElementById('setting-missing-grace-scans')?.value || '3', 10) || 3,
        auto_update: !!document.getElementById('toggle-auto-update')?.checked,
        preferred_source: document.getElementById('set-media-scraper')?.value || 'f95zone',
    };
}

async function loadSettings() {
    try {
        const res = await fetch(`${API_BASE}/api/settings`);
        if (!res.ok) throw new Error('Failed to load settings');
        const settings = await res.json();
        appSettings = settings;

        const dirInput = document.getElementById('setting-games-dir');
        if (dirInput) dirInput.value = settings.games_dir || '';

        const archiveMode = document.getElementById('set-launch-archive-mode');
        if (archiveMode) archiveMode.value = settings.archive_mode || 'explorer';

        const startupScan = document.getElementById('toggle-startup-scan');
        if (startupScan) startupScan.checked = settings.startup_scan !== false;

        const missingGrace = document.getElementById('setting-missing-grace-scans');
        if (missingGrace) missingGrace.value = String(settings.missing_grace_scans || 3);

        const autoUpdate = document.getElementById('toggle-auto-update');
        if (autoUpdate) autoUpdate.checked = settings.auto_update !== false;

        const preferredSource = document.getElementById('set-media-scraper');
        if (preferredSource) preferredSource.value = settings.preferred_source || 'f95zone';

        const sourceBadge = document.getElementById('set-stat-source');
        if (sourceBadge) sourceBadge.textContent = (settings.preferred_source || 'f95zone').toUpperCase();
    } catch (error) {
        console.error('Failed to load settings', error);
    }
}

async function persistSettings() {
    const payload = collectSettingsPayload();
    if (!payload.games_dir) {
        alert("Please specify a valid folder path.");
        return;
    }

    const btn = document.getElementById('btn-save-preferences');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Saving Preferences...</span>`;
    }
    if (window.lucide) lucide.createIcons();

    try {
        const res = await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.detail || 'Unknown error');
        }
        appSettings = data.settings;
        await Promise.all([fetchStats(), fetchTags(), loadGames(), loadSettings()]);
    } catch (error) {
        alert(`Error saving settings: ${error.message}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
        if (window.lucide) lucide.createIcons();
    }
}

async function fetchStats() {
    try {
        const res = await fetch(`${API_BASE}/api/stats`);
        const stats = await res.json();
        
        document.getElementById('stat-total-games').textContent = stats.total;
        document.getElementById('stat-wishlist-games').textContent = stats.wishlist;
        
        const setStatUp = document.getElementById('set-stat-updates');
        if (setStatUp) setStatUp.textContent = stats.wishlist;
        const setStatQ = document.getElementById('set-stat-queue');
        if (setStatQ) setStatQ.textContent = `${stats.unidentified} games`;
        const sourceBadge = document.getElementById('set-stat-source');
        if (sourceBadge && appSettings?.preferred_source) sourceBadge.textContent = appSettings.preferred_source.toUpperCase();
        
        if (stats.games_dir) {
            const dirInput = document.getElementById('setting-games-dir');
            if (dirInput && !dirInput.value) dirInput.value = stats.games_dir;
        }
        if (stats.extension_dir) {
            const extBox = document.getElementById('ext-path-box');
            if (extBox) extBox.textContent = stats.extension_dir;
            const onbBox = document.getElementById('onboarding-ext-path');
            if (onbBox) onbBox.textContent = stats.extension_dir;
        }
        
        const onboardingDone = localStorage.getItem('xdir_onboarding_completed');
        if (!onboardingDone && stats.total === 0) {
            const onbModal = document.getElementById('onboarding-modal');
            if (onbModal) onbModal.style.display = 'flex';
        }
        
    } catch (e) {
        console.debug("Failed to fetch stats", e);
    }
}

async function fetchTags() {
    try {
        const res = await fetch(`${API_BASE}/api/tags/all`);
        const tags = await res.json();
        
        const select = document.getElementById('filter-tag');
        select.innerHTML = '<option value="all">All tags</option>';
        tags.forEach(t => {
            select.innerHTML += `<option value="${t}">${t}</option>`;
        });
    } catch (e) {
        console.error("Failed to load tags", e);
    }
}

function resetFilters() {
    filterState = { preset: 'all', progress: 'all', updates: 'all', tag: 'all', source: 'all', search: '', sort: 'title' };
    document.getElementById('filter-preset').value = 'all';
    document.getElementById('filter-progress').value = 'all';
    document.getElementById('filter-updates').value = 'all';
    document.getElementById('filter-tag').value = 'all';
    document.getElementById('filter-source').value = 'all';
    document.getElementById('search-input').value = '';
    document.getElementById('clear-search').style.display = 'none';
    loadGames();
}

async function loadGames() {
    const grid = document.getElementById('games-grid');
    const empty = document.getElementById('empty-state');
    grid.innerHTML = '';
    empty.style.display = 'none';

    let url = `${API_BASE}/api/games?sort=${encodeURIComponent(filterState.sort)}&`;
    if (filterState.preset !== 'all') {
        if (filterState.preset === 'exe' || filterState.preset === 'archive' || filterState.preset === 'available') {
            url += `status=${filterState.preset}&`;
        }
        if (filterState.preset === 'review') url += `identified=false&`;
    }
    if (filterState.progress !== 'all') url += `progress=${encodeURIComponent(filterState.progress)}&`;
    
    // Updates overrides
    if (filterState.updates === 'updates') url += `update=true&`;
    if (filterState.updates === 'wishlist') url += `status=wishlist&`;
    if (filterState.updates === 'missing_meta') url += `identified=false&`;
    
    if (filterState.tag !== 'all') url += `tag=${encodeURIComponent(filterState.tag)}&`;
    if (filterState.source !== 'all') url += `source=${encodeURIComponent(filterState.source)}&`;
    if (filterState.search) url += `search=${encodeURIComponent(filterState.search)}&`;

    try {
        const res = await fetch(url);
        let data = await res.json();
        
        // Filter out ignored games
        data = data.filter(g => !g.is_ignored);
        
        // Apply wishlist filter
        if (filterState.updates === 'wishlist') {
            data = data.filter(g => g.file_type === 'wishlist');
        } else {
            // By default, hide wishlist games from the main list unless specifically selected
            data = data.filter(g => g.file_type !== 'wishlist');
        }
        
        allGames = data;
        
        document.getElementById('results-count').textContent = `Showing ${allGames.length} titles`;

        if (allGames.length === 0) {
            empty.style.display = 'flex';
            return;
        }

        const fragment = document.createDocumentFragment();
        allGames.forEach(game => {
            fragment.appendChild(createGameCard(game));
        });
        grid.appendChild(fragment);

        if (window.lucide) lucide.createIcons();
    } catch (err) {
        console.error("Failed to fetch games", err);
    }
}

function createGameCard(game) {
    const card = document.createElement('div');
    card.className = 'game-card';
    
    const isExe = game.file_type === 'exe' || game.file_type === 'folder';
    const isWishlist = game.file_type === 'wishlist';
    
    let pillClass = isExe ? 'pill-exe' : 'pill-archive';
    let pillText = isExe ? 'INSTALLED' : 'ARCHIVE';
    if (isWishlist) {
        pillClass = 'pill-wishlist';
        pillText = 'WISHLIST';
    }
    
    const sourceText = game.source_type !== 'unknown' ? game.source_type.toUpperCase() : 'LOCAL';
    
    const topPillHtml = `<span class="card-top-pill ${pillClass}" ${isWishlist ? 'style="background:rgba(96,165,250,0.15); color:#93c5fd; border-color:rgba(96,165,250,0.3);"' : ''}>${pillText}</span>`;

    const deleteWishlistHtml = isWishlist 
        ? `<button class="btn-card-delete-wishlist" title="Remove from Wishlist" style="position: absolute; top: 8px; right: 8px; z-index: 10; background: rgba(0, 0, 0, 0.85); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; border-radius: 6px; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.5); transition: all 0.2s;" onmouseover="this.style.background='rgba(239, 68, 68, 0.9)'; this.style.color='#ffffff';" onmouseout="this.style.background='rgba(0, 0, 0, 0.85)'; this.style.color='#f87171';" onclick="event.stopPropagation(); window.removeWishlistGame(${game.id}, '${(game.title || '').replace(/'/g, "\\'")}');">
               <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
           </button>` 
        : '';

    const coverHtml = game.cover_url
        ? `<img src="${game.cover_url}" alt="${game.title}" class="card-img" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
           <div class="card-fallback" style="display:none;">${game.title.charAt(0)}</div>`
        : `<div class="card-fallback">${game.title.charAt(0)}</div>`;

    // Tag chips (show up to 6)
    const allTagNames = [...(game.tags || []), ...(game.custom_tags || [])];
    const displayTags = allTagNames.slice(0, 6);
    const extraCount = allTagNames.length - displayTags.length;
    
    const tagsHtml = displayTags.map(t => `<span class="card-tag">${t}</span>`).join('') +
                     (extraCount > 0 ? `<span class="card-tag">+${extraCount}</span>` : '');

    card.innerHTML = `
        <div class="card-img-box" style="position: relative;">
            ${topPillHtml}
            ${deleteWishlistHtml}
            ${coverHtml}
        </div>
        <div class="card-info">
            <div class="card-title-row">
                <div class="card-title" title="${game.title}">${game.title}</div>
                <div class="card-rating-box">
                    <span>&#9733;</span>
                    <span>${normalizeRatingText(game.rating)}</span>
                </div>
            </div>
            <div class="card-sub-line">
                <span>by ${game.developer || 'Unknown Dev'}</span>
                <span class="card-separator" aria-hidden="true"></span>
                <span class="source-tag">${sourceText}</span>
            </div>
            <div class="card-tags-row">
                ${tagsHtml || `<span class="card-tag">${game.category || 'General'}</span>`}
            </div>
        </div>
    `;

    card.addEventListener('click', () => {
        const gridEl = document.getElementById('games-grid');
        if (gridEl) lastGridScrollPos = gridEl.scrollTop;
        openOverviewPage(game.id);
    });

    return card;
}

async function openOverviewPage(gameId) {
    try {
        const res = await fetch(`${API_BASE}/api/games/${gameId}`);
        currentGame = await res.json();
        
        isTranslated = false;
        originalMetadata = null;
        const tBtn = document.getElementById('ov-btn-translate');
        if (tBtn) {
            tBtn.innerHTML = renderTranslateButtonLabel('translate');
            tBtn.style.color = '#93c5fd';
        }
        
        renderOverview(currentGame);
        document.getElementById('overview-modal').style.display = 'flex';
        if (window.lucide) lucide.createIcons();
    } catch (err) {
        console.error("Failed to load game details", err);
    }
}

function formatDateTime(value) {
    if (!value) return 'N/A';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function guessEngineLabel(game) {
    const knownEngines = ['Ren\'Py', 'RPGM', 'Wolf RPG', 'Unity', 'HTML', 'Flash', 'VN', 'QTE'];
    const allTags = [...(game.tags || []), ...(game.custom_tags || [])];
    const match = knownEngines.find(engine => allTags.some(tag => String(tag).toLowerCase() === engine.toLowerCase()));
    if (match) return match;
    if (game.file_type === 'archive') return 'Archive Build';
    if (game.source_type && game.source_type !== 'unknown') return `${game.source_type.toUpperCase()} Linked`;
    return 'Standalone Build';
}

function renderOverview(game) {
    const isExe = game.file_type === 'exe' || game.file_type === 'folder';
    const isWishlist = game.file_type === 'wishlist';
    const currentIndex = allGames.findIndex(entry => entry.id === game.id);

    // Topbar
    document.getElementById('ov-title-top').textContent = game.title;
    document.getElementById('ov-page-num').textContent = currentIndex >= 0 ? `${currentIndex + 1} of ${allGames.length}` : 'Library view';
    
    // Hero
    const heroBg = document.getElementById('ov-hero-bg');
    if (game.cover_url) {
        heroBg.style.backgroundImage = `url('${game.cover_url}')`;
    } else {
        heroBg.style.backgroundImage = `none`;
        heroBg.style.backgroundColor = `#161820`;
    }
    
    document.getElementById('ov-title').textContent = game.title;
    document.getElementById('ov-dev').textContent = `Developer: ${game.developer || 'Unknown Dev / Circle'}`;
    document.getElementById('ov-engine').textContent = `Engine: ${guessEngineLabel(game)}`;
    
    document.getElementById('ov-badge-update').style.display = game.update_available ? 'inline-block' : 'none';
    document.getElementById('ov-badge-version').textContent = `DATA: ${game.local_version || 'V1.0'}`;
    document.getElementById('ov-badge-date').textContent = `RELEASED: ${game.release_date || 'N/A'}`;
    
    // Controls box
    document.getElementById('ov-launch-text').textContent = isWishlist ? 'Wishlist Item' : (isExe ? 'Launch' : 'Open Folder');
    document.getElementById('ov-path-short').textContent = isWishlist
        ? 'No local folder linked yet'
        : (game.folder_path.length > 30 ? game.folder_path.substring(0, 30) + '...' : game.folder_path);
    document.getElementById('ov-type-text').textContent = isWishlist ? 'WISHLIST ENTRY' : (isExe ? 'INSTALLED EXE' : 'ZIP/RAR ARCHIVE');
    const launchBtn = document.getElementById('ov-btn-launch');
    const folderBtn = document.getElementById('ov-btn-folder');
    if (launchBtn) launchBtn.disabled = isWishlist;
    if (folderBtn) folderBtn.disabled = isWishlist;
    
    // Metrics
    updateStarPickerUI(game.user_score);
    document.getElementById('ov-source-name').textContent = game.source_type.toUpperCase() || 'LOCAL';
    document.getElementById('ov-platform-score').textContent = normalizeRatingText(game.rating);
    document.getElementById('ov-progress-select').value = game.playing_progress || 'unplayed';
    document.getElementById('ov-size-text').textContent = `${game.file_type.toUpperCase()} | ${game.folder_path}`;
    document.getElementById('ov-folder-full').textContent = isWishlist ? 'Link this wishlist item to a scanned local folder or executable.' : (game.folder_path || 'Unknown path');
    document.getElementById('ov-local-version-text').textContent = game.local_version || 'Unknown';
    document.getElementById('ov-latest-version-text').textContent = game.latest_version || 'Not fetched';
    document.getElementById('ov-added-at-text').textContent = formatDateTime(game.added_at);
    document.getElementById('ov-last-seen-text').textContent = formatDateTime(game.last_seen_at);
    document.getElementById('ov-missing-status-text').textContent = `${game.missing_scan_count || 0} missed scan(s)`;

    const coverImg = document.getElementById('ov-cover-image');
    const coverFallback = document.getElementById('ov-cover-fallback');
    if (coverImg && coverFallback) {
        if (game.cover_url) {
            coverImg.src = game.cover_url;
            coverImg.style.display = 'block';
            coverFallback.style.display = 'none';
        } else {
            coverImg.removeAttribute('src');
            coverImg.style.display = 'none';
            coverFallback.style.display = 'flex';
            coverFallback.textContent = (game.title || '?').charAt(0).toUpperCase();
        }
    }
    
    // Gallery
    const gallery = document.getElementById('ov-gallery');
    gallery.innerHTML = '';
    const shots = game.screenshots || [];
    document.getElementById('ov-gallery-count').textContent = shots.length;
    
    if (shots.length > 0) {
        shots.forEach(url => {
            const img = document.createElement('img');
            img.src = url;
            img.className = 'ov-gallery-img';
            img.referrerPolicy = 'no-referrer';
            img.onerror = () => { img.style.display = 'none'; };
            img.onclick = () => {
                document.getElementById('lightbox-img').src = url;
                document.getElementById('lightbox-modal').style.display = 'flex';
            };
            gallery.appendChild(img);
        });
    } else {
        gallery.innerHTML = `<div style="grid-column: span 3; padding: 24px; background: rgba(59, 130, 246, 0.08); border: 1px dashed rgba(96, 165, 250, 0.35); border-radius: 12px; color: #fff; text-align: center;">No screenshots scraped yet. Visit this game's F95zone or DLsite thread in Chrome and click the floating badge to auto-sync.</div>`;
    }

    // Tags
    const cloud = document.getElementById('ov-tag-cloud');
    cloud.innerHTML = '';
    const allTags = [...(game.tags || []), ...(game.custom_tags || [])];
    if (allTags.length > 0) {
        allTags.forEach(t => {
            cloud.innerHTML += `<span class="tag-chip">${t}</span>`;
        });
    } else {
        cloud.innerHTML = `<span class="tag-chip">${game.category || 'General'}</span>`;
    }

    // Description
    document.getElementById('ov-description').textContent = game.description || 'No description available yet. Click above or use the companion extension to auto-scrape from F95zone or DLsite!';
    const descBtn = document.getElementById('ov-btn-fetch-desc');
    if (descBtn) {
        if (!game.description || game.description.includes('No description available')) {
            descBtn.style.display = 'inline-flex';
        } else {
            descBtn.style.display = 'none';
        }
    }

    // Journal
    const jList = document.getElementById('ov-journal-list');
    const entries = game.journal_entries || [];
    if (entries.length > 0) {
        jList.innerHTML = entries.map(j => `
            <div style="padding: 12px; background: var(--bg-box); border: 1px solid var(--border-dark); border-radius: 10px; margin-bottom: 10px;">
                <div style="font-size: 0.75rem; color: var(--accent-red); font-weight: 700; margin-bottom: 4px;">${j.date}</div>
                <div style="font-size: 0.9rem; color: #fff;">${j.text}</div>
            </div>
        `).join('');
    } else {
        jList.innerHTML = `
            <div class="journal-empty">
                <i data-lucide="file-text"></i>
                <h4>No journal entries yet</h4>
                <p>Start documenting your gameplay experience or patch notes.</p>
            </div>
        `;
    }

    // Sources
    const sList = document.getElementById('ov-source-list');
    if (game.source_url && game.source_url.startsWith('http')) {
        sList.innerHTML = `
            <div class="source-card">
                <div class="source-top">
                    <div class="source-badge-main">
                        <span class="pill-primary">${game.source_type.toUpperCase()}</span>
                        <span>ID: ${game.source_id || 'Linked'}</span>
                    </div>
                </div>
                <a href="${game.source_url}" target="_blank" class="source-link">${game.source_url}</a>
            </div>
        `;
    } else {
        sList.innerHTML = `
            <div class="source-card">
                <div class="source-top">
                    <div class="source-badge-main">
                        <span class="pill-primary">LOCAL FOLDER</span>
                        <span>Unlinked</span>
                    </div>
                </div>
                <p style="font-size: 0.8rem; color: var(--text-muted);">Manually managed game folder: ${game.folder_path || 'Local library'}</p>
            </div>
        `;
    }

    // Archive inspector
    const archBox = document.getElementById('ov-archive-inspector');
    const archList = document.getElementById('ov-archive-list');
    if (game.file_type === 'archive' && game.archive_contents && game.archive_contents.length > 0) {
        archBox.style.display = 'flex';
        archList.innerHTML = '<ul style="list-style:none; font-size:0.85rem; color:var(--text-silver); display:flex; flex-direction:column; gap:6px;">' +
            game.archive_contents.map(f => `<li>${f}</li>`).join('') + '</ul>';
    } else if (archBox) {
        archBox.style.display = 'none';
    }

    // Reset link form when switching games
    const linkFormEl = document.getElementById('ov-link-form');
    if (linkFormEl) linkFormEl.style.display = 'none';
    const linkInputEl = document.getElementById('ov-link-url-input');
    if (linkInputEl) linkInputEl.value = '';
    const localLinkBtnEl = document.getElementById('ov-btn-link-local');
    if (localLinkBtnEl) localLinkBtnEl.style.display = isWishlist ? 'flex' : 'none';
    const localLinkFormEl = document.getElementById('ov-local-link-form');
    if (localLinkFormEl) localLinkFormEl.style.display = 'none';
    const localLinkSearchEl = document.getElementById('ov-local-link-search');
    if (localLinkSearchEl) localLinkSearchEl.value = '';
    const localLinkSelectEl = document.getElementById('ov-local-link-select');
    if (localLinkSelectEl) localLinkSelectEl.innerHTML = '';

    // Update "Wrong Data" button label based on source state
    const wrongBtn = document.getElementById('ov-btn-mark-wrong');
    if (wrongBtn) {
        if (game.source_type === 'unknown' || !game.source_url) {
            wrongBtn.innerHTML = `<i data-lucide="alert-triangle"></i> <span>No Source / Try Re-scrape</span>`;
        } else {
            wrongBtn.innerHTML = `<i data-lucide="alert-triangle"></i> <span>Wrong Data / Re-scrape</span>`;
        }
    }

    if (window.lucide) lucide.createIcons();
}

async function launchGame(gameId, openFolderOnly = false) {
    try {
        const res = await fetch(`${API_BASE}/api/games/${gameId}/launch`, { method: 'POST' });
        const data = await res.json();
        console.log(data.message);
    } catch (err) {
        alert("Failed to launch executable or open Explorer folder");
    }
}

async function loadExtensionQueue() {
    const list = document.getElementById('ext-queue-list');
    if (!list) return;
    list.innerHTML = '';
    
    try {
        const res = await fetch(`${API_BASE}/api/games/needs-metadata`);
        const games = await res.json();
        
        if (games.length === 0) {
            list.innerHTML = `<div style="grid-column: span 3; padding: 24px; text-align: center; color: var(--badge-green); font-weight: 700;">All identified games have cover images and metadata synced.</div>`;
            return;
        }
        
        games.forEach(g => {
            const cleanQuery = encodeURIComponent(g.title);
            const f95Url = `https://f95zone.to/sam/latest_alpha/latest_data.php?cmd=list&cat=games&search=${cleanQuery}`;
            const dlsiteUrl = `https://www.dlsite.com/home/fsr/=/keyword/${cleanQuery}`;
            
            list.innerHTML += `
                <div class="queue-item">
                    <div class="queue-info">
                        <h4>${g.title}</h4>
                        <span>${g.folder_path}</span>
                    </div>
                    <div style="display:flex; gap:8px;">
                        <button class="btn-secondary" style="padding:6px 10px;" onclick="window.open('${f95Url}', '_blank')">F95</button>
                        <button class="btn-secondary" style="padding:6px 10px;" onclick="window.open('${dlsiteUrl}', '_blank')">DLsite</button>
                    </div>
                </div>
            `;
        });
    } catch (err) {
        console.error("Failed to load queue", err);
    }
}

function updateStarPickerUI(scoreStr) {
    const starBtns = document.querySelectorAll('.user-star-btn');
    const clearBtn = document.getElementById('ov-clear-star');
    const scoreNum = document.getElementById('ov-score-num');
    let num = 0;
    if (scoreStr && scoreStr !== 'N/A') {
        num = parseInt(scoreStr, 10) || 0;
    }
    starBtns.forEach(btn => {
        const val = parseInt(btn.getAttribute('data-val'), 10);
        if (val <= num) {
            btn.style.color = '#fbbf24';
            btn.style.transform = 'scale(1.15)';
            btn.style.textShadow = '0 0 10px rgba(251, 191, 36, 0.5)';
        } else {
            btn.style.color = '#334155';
            btn.style.transform = 'scale(1)';
            btn.style.textShadow = 'none';
        }
    });
    if (num > 0) {
        if (clearBtn) clearBtn.style.display = 'inline-block';
        if (scoreNum) scoreNum.textContent = `${num}/5`;
    } else {
        if (clearBtn) clearBtn.style.display = 'none';
        if (scoreNum) scoreNum.textContent = 'N/A';
    }
}

window.removeWishlistGame = async function(id, title) {
    if (!confirm(`Remove "${title}" from your Wishlist?`)) return;
    try {
        const res = await fetch(`${API_BASE}/api/games/${id}`, {
            method: 'DELETE'
        });
        if (res.ok) {
            const ovModal = document.getElementById('overview-modal');
            if (ovModal && ovModal.style.display === 'flex' && currentGame && currentGame.id === id) {
                ovModal.style.display = 'none';
            }
            await fetchStats();
            await loadGames();
        } else {
            alert("Failed to remove game from wishlist.");
        }
    } catch (e) {
        alert("Error removing game: " + e);
    }
};


