function parseDLsite(doc = document) {
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
        const titleEl = doc.querySelector('#work_name') || doc.querySelector('h1');
        if (titleEl) result.title = titleEl.textContent.trim();

        // 2. Developer / Circle
        const devEl = doc.querySelector('.maker_name a') || doc.querySelector('#work_maker');
        if (devEl) result.developer = devEl.textContent.trim();

        // 3. Rating
        const rateEl = doc.querySelector('.point') || doc.querySelector('.star_rating');
        if (rateEl) result.rating = rateEl.textContent.trim();

        // 4. Tags / Genres
        doc.querySelectorAll('.main_genre a, .genre a, #work_outline .main_genre a').forEach(a => {
            const tag = a.textContent.trim();
            if (tag && !result.tags.includes(tag)) result.tags.push(tag);
        });

        // 5. Cover & Screenshots
        const mainImg = doc.querySelector('#work_left .product-slider-data div[data-src], #work_left img');
        if (mainImg) {
            result.cover_url = mainImg.getAttribute('data-src') || mainImg.src;
        }

        doc.querySelectorAll('.product-slider-data div[data-src], .slider_item img').forEach(el => {
            const url = el.getAttribute('data-src') || el.src;
            if (url && url.startsWith('http') && url !== result.cover_url && !result.screenshots.includes(url)) {
                result.screenshots.push(url);
            }
        });

        // 6. Version & Update History
        const updateBox = doc.querySelector('#work_update, .work_update_list, .work_article');
        if (updateBox) {
            const txt = updateBox.textContent;
            const verMatch = txt.match(/(?:ver|v|version)[\s\._-]*(\d+(?:\.\d+)+)/i);
            if (verMatch) {
                result.latest_version = `v${verMatch[1]}`;
            }
        }

        // 7. Description
        const descEl = doc.querySelector('.work_article, #work_article');
        if (descEl) {
            result.description = descEl.textContent.trim().substring(0, 400) + '...';
        }

    } catch (e) {
        console.error('DLsite parsing error:', e);
    }

    return result;
}
