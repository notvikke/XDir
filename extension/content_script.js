(function() {
    if (document.getElementById('xdir-extension-badge')) return;

    let parsedData = null;
    if (window.location.href.includes('f95zone.to/threads/')) {
        parsedData = typeof parseF95zone === 'function' ? parseF95zone() : null;
    } else if (window.location.href.includes('dlsite.com')) {
        parsedData = typeof parseDLsite === 'function' ? parseDLsite() : null;
    } else if (window.location.href.includes('.itch.io/')) {
        parsedData = typeof parseItch === 'function' ? parseItch() : null;
    }

    if (!parsedData) return;

    chrome.runtime.sendMessage({ type: 'CHECK_GAME_STATUS', payload: parsedData }, (response) => {
        if (chrome.runtime.lastError) {
            console.log('XDir background connection not ready or app closed');
            return;
        }

        renderBadge(response || { inLibrary: false }, parsedData);
    });

    function badgeIconHtml() {
        return `<img class="xdir-badge-icon" src="${chrome.runtime.getURL('icon128.png')}" alt="XDir">`;
    }

    function renderBadge(status, metadata) {
        const badge = document.createElement('div');
        badge.id = 'xdir-extension-badge';

        if (status.inLibrary) {
            const game = status.game;
            const isExe = game.file_type === 'exe' || game.file_type === 'folder';
            const pillClass = isExe ? 'xdir-pill-exe' : 'xdir-pill-archive';
            const pillText = isExe ? 'INSTALLED' : 'ARCHIVE';

            let updateHtml = '';
            if (game.update_available || (metadata.latest_version && metadata.latest_version !== game.local_version)) {
                updateHtml = `<span class="xdir-status-pill xdir-pill-update">UPDATE AVAILABLE</span>`;
            }

            badge.innerHTML = `
                ${badgeIconHtml()}
                <div class="xdir-badge-text">
                    <div class="xdir-title">
                        In Your XDir Library
                        <span class="xdir-status-pill ${pillClass}">${pillText}</span>
                        ${updateHtml}
                    </div>
                    <div class="xdir-subtitle">
                        ${game.folder_path} | Local: ${game.local_version || 'v1.0'}
                    </div>
                </div>
            `;

            badge.addEventListener('click', () => {
                badge.style.transform = 'scale(0.95)';
                chrome.runtime.sendMessage({ type: 'SYNC_METADATA', payload: metadata }, (res) => {
                    badge.style.transform = '';
                    if (res && res.success) {
                        const title = badge.querySelector('.xdir-title');
                        if (title) title.textContent = 'Metadata Synced to XDir!';
                        setTimeout(() => location.reload(), 1500);
                    }
                });
            });
        } else {
            badge.innerHTML = `
                ${badgeIconHtml()}
                <div class="xdir-badge-text">
                    <div class="xdir-title">Add / Link to XDir Library App</div>
                    <div class="xdir-subtitle">Click to sync screenshots and metadata to your local manager</div>
                </div>
            `;

            badge.addEventListener('click', () => {
                badge.style.transform = 'scale(0.95)';
                chrome.runtime.sendMessage({ type: 'SYNC_METADATA', payload: metadata }, (res) => {
                    badge.style.transform = '';
                    if (res && res.success) {
                        badge.innerHTML = `
                            ${badgeIconHtml()}
                            <div class="xdir-badge-text">
                                <div class="xdir-title">Sent to XDir App!</div>
                                <div class="xdir-subtitle">Check your standalone window</div>
                            </div>
                        `;
                    } else {
                        alert('Could not connect to XDir Standalone App. Make sure the app is running.');
                    }
                });
            });
        }

        document.body.appendChild(badge);
    }
})();
