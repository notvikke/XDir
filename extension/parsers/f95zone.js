function parseF95zone(doc = document) {
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
        // 1. Title & Version from H1 or Document Title
        const h1 = doc.querySelector('h1.p-title-value') || doc.querySelector('h1');
        const titleText = h1 ? h1.textContent.trim() : doc.title;
        result.title = titleText.replace(/\[.*?\]/g, '').replace(/\{.*?\}/g, '').trim();
        
        // Extract version e.g., [v1.08], [Ver. 2.3], [1.0.5c]
        const verMatch = titleText.match(/\[(?:v|ver|build|rev)?[\s\._-]*(\d+(?:\.\d+)+(?:[a-z])?|\d+(?:\.\d+)?|[0-9]{4}-[0-9]{2}-[0-9]{2})\]/i);
        if (verMatch) {
            let v = verMatch[1].trim();
            result.latest_version = v.toLowerCase().startsWith('v') ? v : `v${v}`;
        }

        // 2. Tags & Prefixes
        doc.querySelectorAll('.labelLink, .p-title-value .label, .tagItem').forEach(el => {
            const tag = el.textContent.trim();
            if (tag && !tag.includes('Completed') && !tag.includes('Ongoing') && tag.length > 1) {
                result.tags.push(tag);
            }
        });

        // 3. First post content (metadata & images)
        const firstPost = doc.querySelector('.message-body .bbWrapper') || doc.querySelector('.bbWrapper');
        if (firstPost) {
            // Find Developer / Creator
            const textContent = firstPost.innerText || '';
            const devMatch = textContent.match(/(?:Developer|Creator|Publisher|Circle)\s*:\s*([^\n\r]+)/i);
            if (devMatch && devMatch[1]) {
                result.developer = devMatch[1].replace(/\[.*?\]/g, '').trim();
            }

            // Description summary
            const paragraphs = firstPost.querySelectorAll('p, div');
            for (let p of paragraphs) {
                let txt = p.textContent.trim();
                if (txt.length > 60 && !txt.startsWith('Overview') && !txt.startsWith('Thread')) {
                    result.description = txt.substring(0, 400) + '...';
                    break;
                }
            }

            // Images (Cover + Screenshots)
            const imgs = Array.from(firstPost.querySelectorAll('img')).map(img => img.src || img.getAttribute('data-src') || img.getAttribute('data-url')).filter(Boolean);
            
            const validImgs = imgs.filter(url => {
                return url.startsWith('http') && 
                       !url.includes('/smilies/') && 
                       !url.includes('/emoticons/') && 
                       !url.includes('/avatars/') &&
                       !url.includes('data:image');
            });

            if (validImgs.length > 0) {
                result.cover_url = validImgs[0];
                // Remaining images as screenshot gallery
                result.screenshots = validImgs.slice(1, 16);
            }
        }

        // 4. Rating if available
        const ratingEl = doc.querySelector('.br-score') || doc.querySelector('.starRating span');
        if (ratingEl) {
            result.rating = ratingEl.textContent.trim();
        }

    } catch (e) {
        console.error('F95zone parsing error:', e);
    }

    return result;
}
