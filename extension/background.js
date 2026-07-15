const API_BASE = "http://127.0.0.1:8765";

function sendHeartbeat() {
    fetch(`${API_BASE}/api/extension/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: "0.3.0" })
    })
    .then(res => res.json())
    .then(data => {
        if (data && data.trigger_queue && typeof processMetadataQueue === 'function') {
            processMetadataQueue();
        }
    })
    .catch(err => console.debug("Server offline for ping"));
}

// Send immediately and repeat every 5 seconds
sendHeartbeat();
setInterval(sendHeartbeat, 5000);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CHECK_GAME_STATUS') {
        sendHeartbeat();
        const payload = message.payload;
        if (!payload || !payload.source_url) {
            sendResponse({ inLibrary: false });
            return true;
        }

        // Clean URL to match
        const cleanUrl = payload.source_url.split('#')[0].split('?')[0];
        
        fetch(`${API_BASE}/api/games`)
            .then(res => res.json())
            .then(games => {
                const match = games.find(g => {
                    if (g.source_url && g.source_url.includes(cleanUrl)) return true;
                    if (payload.title && g.title.toLowerCase() === payload.title.toLowerCase()) return true;
                    return false;
                });

                if (match) {
                    sendResponse({ inLibrary: true, game: match });
                } else {
                    sendResponse({ inLibrary: false });
                }
            })
            .catch(err => {
                console.error("Failed to connect to XDir app:", err);
                sendResponse({ inLibrary: false, error: "Offline" });
            });

        return true; // Asynchronous response
    }

    if (message.type === 'SYNC_METADATA') {
        sendHeartbeat();
        fetch(`${API_BASE}/api/metadata/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message.payload)
        })
        .then(res => res.json())
        .then(data => sendResponse({ success: true, data }))
        .catch(err => {
            console.error("Sync failed:", err);
            sendResponse({ success: false, error: err.toString() });
        });

        return true;
    }
});

let isQueueRunning = false;
async function processMetadataQueue() {
    if (isQueueRunning) return;
    isQueueRunning = true;
    try {
        const res = await fetch(`${API_BASE}/api/games`);
        if (!res.ok) { isQueueRunning = false; return; }
        const games = await res.json();
        
        const missing = games.filter(g => g.source_type === 'unknown' || !g.cover_url);
        if (missing.length === 0) { isQueueRunning = false; return; }
        
        console.log(`[XDir Extension] Processing ${missing.length} missing metadata items via Chrome...`);
        for (const g of missing) {
            const text = `${g.raw_name || ''} ${g.folder_path || ''} ${g.title || ''}`;
            const rjMatch = text.match(/([R|V|B]J\d{6,8})/i);
            
            if (rjMatch) {
                const code = rjMatch[1].toUpperCase();
                for (const cat of ['maniax', 'home', 'pro', 'girls', 'books']) {
                    try {
                        const apiRes = await fetch(`https://www.dlsite.com/${cat}/api/=/product.json?work_no=${code}`);
                        if (apiRes.ok) {
                            const dataList = await apiRes.json();
                            if (dataList && dataList.length > 0) {
                                const d = dataList[0];
                                // CRITICAL: Validate the returned workno matches our query
                                const returnedCode = (d.workno || '').toUpperCase();
                                if (returnedCode !== code) continue; // DLsite returned a fallback product
                                const cover = (d.image_main && d.image_main.url) ? "https:" + d.image_main.url : null;
                                const shots = (d.image_samples || []).map(s => s.url ? "https:" + s.url : null).filter(Boolean).slice(0, 15);
                                const tags = (d.genres || []).map(x => x.name).filter(Boolean).slice(0, 10);
                                const desc = (d.intro_s || d.intro || '').slice(0, 1000);
                                
                                if (cover || d.work_name) {
                                    await fetch(`${API_BASE}/api/metadata/sync`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            title: d.work_name || g.title,
                                            developer: d.maker_name || 'Unknown',
                                            cover_url: cover,
                                            screenshots: shots,
                                            description: desc,
                                            tags: tags,
                                            source_type: 'dlsite',
                                            source_id: code,
                                            source_url: `https://www.dlsite.com/maniax/work/=/product_id/${code}.html`,
                                            local_folder: g.folder_path
                                        })
                                    });
                                    break;
                                }
                            }
                        }
                    } catch(e) {}
                }
            } else {
                let clean = (g.title || '').replace(/(\bv\d+.*|\b\d+b\b|rev\d+|fixed|ver\b.*|\b\d+\b|windows|edition|complete|deluxe|game|part|chapter|english|translated|archive|rar|zip|7z|\bv\d+\b).*/gi, '').replace(/[_\-\.\[\]\(\)\{\}]/g, ' ').trim();
                const words = clean.split(/\s+/).filter(w => w.length > 2 && !['zip','7z','rar','ver','rev','exe','game','part','final','mod','the','and','for','with','from','complete','edition','deluxe','patched'].includes(w.toLowerCase()));
                if (words.length > 0) {
                    let best = null;
                    let bestScore = 0;
                    let minScore = 1;
                    const maxAttempts = Math.min(3, words.length);
                    
                    for (let numWords = maxAttempts; numWords >= 1; numWords--) {
                        if (best) break;
                        const query = words.slice(0, numWords).join(" ");
                        if (numWords === 1 && query.length < 4) continue;
                        
                        try {
                            const f95Res = await fetch(`https://f95zone.to/sam/latest_alpha/latest_data.php?cmd=list&cat=games&search=${encodeURIComponent(query)}`);
                            if (f95Res.ok) {
                                const f95Json = await f95Res.json();
                                if (f95Json && f95Json.msg && Array.isArray(f95Json.msg.data)) {
                                    for (const item of f95Json.msg.data) {
                                        const tLow = (item.title || '').toLowerCase();
                                        const score = words.reduce((acc, w) => acc + (tLow.includes(w.toLowerCase()) ? 1 : 0), 0);
                                        if (score > bestScore) { bestScore = score; best = item; }
                                    }
                                    minScore = words.length >= 2 ? Math.max(1, Math.floor(words.length * 0.75)) : 1;
                                    if (best && bestScore >= minScore && (bestScore >= 2 || words.length <= 1)) {
                                        break; // Valid match found!
                                    } else {
                                        best = null;
                                        bestScore = 0;
                                    }
                                }
                            }
                        } catch(e) {}
                    }

                    if (best && bestScore >= minScore && (bestScore >= 2 || words.length <= 1)) {
                        let cleanT = (best.title || '').replace(/\[[^\]]*\]/g, '').replace(/^(Completed|VN|RPGM|Unity|3D|2D|Flash|HTML|In Development|On Hold|Abandoned|Collection|Mod|Cheat)\s*[\-\:]\s*/i, '').trim();
                                    await fetch(`${API_BASE}/api/metadata/sync`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            title: cleanT || g.title,
                                            developer: best.creator || 'Unknown',
                                            cover_url: best.cover,
                                            latest_version: best.version,
                                            source_type: 'f95zone',
                                            source_id: String(best.thread_id),
                                            source_url: `https://f95zone.to/threads/${best.thread_id}/`,
                                            local_folder: g.folder_path
                                        })
                                    });
                                }
                }
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    } catch(err) {
        console.debug("Queue sync error:", err);
    } finally {
        isQueueRunning = false;
    }
}

// Periodic background check for games needing metadata (safely wrapped)
try {
    if (typeof chrome !== 'undefined' && chrome.alarms && typeof chrome.alarms.create === 'function') {
        chrome.alarms.create('heartbeat_ping', { periodInMinutes: 0.15 });
        chrome.alarms.create('sync_metadata_queue', { periodInMinutes: 0.5 });
        if (chrome.alarms.onAlarm && typeof chrome.alarms.onAlarm.addListener === 'function') {
            chrome.alarms.onAlarm.addListener((alarm) => {
                if (alarm && alarm.name === 'heartbeat_ping') {
                    sendHeartbeat();
                }
                if (alarm && alarm.name === 'sync_metadata_queue') {
                    processMetadataQueue();
                }
            });
        }
    }
} catch (err) {
    console.debug("Chrome alarms API not available or permission not yet reloaded:", err);
}

// Start initial check after 5 seconds
setTimeout(processMetadataQueue, 5000);
