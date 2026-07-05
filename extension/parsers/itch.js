function parseItch(doc = document) {
    const result = {
        source_url: window.location.href.split('#')[0].split('?')[0],
        cover_url: null,
        latest_version: null,
        developer: null,
        screenshots: [],
        tags: [],
        rating: null,
        description: null
    };

    try {
        // 1. Title
        const titleEl = doc.querySelector('h1.game_title') || doc.querySelector('.game_title');
        if (titleEl) result.title = titleEl.textContent.trim();

        // 2. Developer
        const devEl = doc.querySelector('.game_info_panel a[href*="/user/"], .game_info_panel td a');
        if (devEl) result.developer = devEl.textContent.trim();

        // 3. Cover & Screenshots
        const headerImg = doc.querySelector('.header img, #screenshot_container img');
        if (headerImg) result.cover_url = headerImg.src || headerImg.getAttribute('data-lazy_src');

        doc.querySelectorAll('.screenshot_list a, .screenshot_list img').forEach(el => {
            const url = el.href || el.src || el.getAttribute('data-lazy_src');
            if (url && url.startsWith('http') && url !== result.cover_url && !result.screenshots.includes(url)) {
                result.screenshots.push(url);
            }
        });

        // 4. Tags
        doc.querySelectorAll('.game_info_panel td a[href*="/tag/"]').forEach(a => {
            const tag = a.textContent.trim();
            if (tag && !result.tags.includes(tag)) result.tags.push(tag);
        });

        // 5. Description
        const descEl = doc.querySelector('.formatted_description');
        if (descEl) {
            result.description = descEl.textContent.trim().substring(0, 400) + '...';
        }

    } catch (e) {
        console.error('Itch parsing error:', e);
    }

    return result;
}
