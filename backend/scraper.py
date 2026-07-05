import re
import json
import urllib.request
import urllib.parse
import requests
from bs4 import BeautifulSoup
from typing import Optional, List, Dict, Any
from sqlalchemy.orm import Session
from backend.database import Game, Screenshot, Tag

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9,ja;q=0.8"
}

def format_rating(avg_value: Any, count_value: Any = None, count_label: str = "votes") -> Optional[str]:
    try:
        average = round(float(avg_value), 1)
    except Exception:
        return None

    if average <= 0:
        return None

    try:
        count = int(count_value) if count_value not in (None, "", 0, "0") else 0
    except Exception:
        count = 0

    if count > 0:
        return f"{average} / 5 ({count} {count_label})"
    return f"{average} / 5"

def _google_translate_jp_en(text: str) -> str:
    if not text: return text
    try:
        if not re.search(r'[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]', text):
            return text
        url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=en&dt=t&q=' + urllib.parse.quote(text)
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        r = urllib.request.urlopen(req, timeout=5).read()
        res = json.loads(r)
        return "".join([part[0] for part in res[0]])
    except Exception:
        return text

def scrape_dlsite(url: str, code: str) -> Dict[str, Any]:
    res = {}
    if not code and url:
        m = re.search(r'([RVB]J\d{6,8})', url, flags=re.IGNORECASE)
        if m:
            code = m.group(1).upper()
            
    if code:
        code = code.upper()
        for cat in ['maniax', 'home', 'pro', 'girls', 'books']:
            try:
                api_url = f"https://www.dlsite.com/{cat}/api/=/product.json?work_no={code}"
                r = requests.get(api_url, headers=HEADERS, timeout=10)
                if r.status_code == 200 and r.json():
                    data = r.json()[0]
                    # CRITICAL: Validate the returned workno matches our query.
                    # DLsite API returns a random fallback product (VJ01006520) when no match is found.
                    returned_code = (data.get('workno') or '').upper()
                    if returned_code != code:
                        continue  # Skip this category because the API returned a different product.
                    if data.get('image_main') and data['image_main'].get('url'):
                        res['cover_url'] = "https:" + data['image_main']['url']
                    if data.get('work_name'):
                        res['title'] = data['work_name']
                    if data.get('maker_name'):
                        res['developer'] = data['maker_name']
                    if data.get('intro_s') or data.get('intro'):
                        res['description'] = (data.get('intro_s') or data.get('intro') or '')[:1000]
                    if data.get('image_samples'):
                        res['screenshots'] = [("https:" + s['url']) for s in data['image_samples'] if s.get('url')][:15]
                    if data.get('genres'):
                        res['tags'] = [g['name'] for g in data['genres'] if g.get('name')][:10]
                        
                    avg_val = data.get('rate_average_2dp') or data.get('rate_average_star') or data.get('rate_average')
                    if avg_val and float(avg_val) > 0:
                        count_val = data.get('rate_count') or data.get('review_count') or sum(data.get('rate_count_detail', {}).values()) or 0
                        res['rating'] = format_rating(avg_val, count_val, "users")

                    if res.get('title'):
                        # Temporarily disabled auto-translate to save original native title
                        pass
                    if res.get('cover_url') or res.get('title'):
                        return res
            except Exception:
                continue

    if not url and code:
        url = f"https://www.dlsite.com/maniax/work/=/product_id/{code}.html"
    if not url:
        return res

    urls_to_try = [url]
    if "maniax" in url:
        urls_to_try.append(url.replace("/maniax/", "/pro/"))
        urls_to_try.append(url.replace("/maniax/", "/home/"))
    elif "pro" in url:
        urls_to_try.append(url.replace("/pro/", "/maniax/"))
        urls_to_try.append(url.replace("/pro/", "/home/"))

    html = ""
    for try_u in urls_to_try:
        try:
            r = requests.get(try_u, headers=HEADERS, timeout=10)
            if r.status_code == 200:
                html = r.text
                break
        except Exception:
            continue

    if not html:
        return res

    soup = BeautifulSoup(html, 'html.parser')

    og_img = soup.find('meta', property='og:image')
    if og_img and og_img.get('content'):
        res['cover_url'] = og_img['content']
    else:
        pic = soup.find('picture', id='work_left')
        if pic:
            img = pic.find('img')
            if img and img.get('src'):
                res['cover_url'] = "https:" + img['src'] if img['src'].startswith("//") else img['src']

    og_title = soup.find('meta', property='og:title')
    if og_title and og_title.get('content'):
        clean_t = og_title['content'].split(' [')[0].split(' |')[0].strip()
        res['title'] = clean_t

    maker = soup.find('span', class_='maker_name')
    if not maker:
        maker = soup.find('a', href=re.compile(r'/maker/'))
    if maker:
        res['developer'] = maker.text.strip()

    desc = soup.find('div', itemprop='description')
    if not desc:
        desc = soup.find('meta', property='og:description')
        if desc:
            res['description'] = desc.get('content', '').strip()
    else:
        res['description'] = desc.get_text(separator=' ', strip=True)[:1000]

    shots = []
    for img in soup.find_all('img'):
        src = img.get('src') or img.get('data-src') or ''
        if src.startswith("//"):
            src = "https:" + src
        if '/modpub/images2/work/' in src and ('sample' in src or '_img_' in src):
            if src != res.get('cover_url') and src not in shots:
                shots.append(src)
    if shots:
        res['screenshots'] = shots[:15]

    tags = []
    genre_box = soup.find('div', class_='main_genre')
    if genre_box:
        for a in genre_box.find_all('a'):
            t = a.text.strip()
            if t and t not in tags:
                tags.append(t)
    if tags:
        res['tags'] = tags[:10]

    return res

def scrape_f95zone(url: str) -> Dict[str, Any]:
    res = {}
    if not url:
        return res

    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        if r.status_code != 200:
            return res
        html = r.text
    except Exception:
        return res

    soup = BeautifulSoup(html, 'html.parser')

    title_el = soup.title
    if title_el:
        full_t = title_el.text.strip()
        parts = full_t.split('|')[0].strip()
        
        tags = []
        rest = parts
        if ' - ' in parts:
            tag_part, rest = parts.split(' - ', 1)
            for t in tag_part.split('-'):
                t_clean = t.strip()
                if t_clean and t_clean not in tags:
                    tags.append(t_clean)
        
        # Check standard engines
        for eng in ['Ren\'Py', 'RPGM', 'Wolf RPG', 'Unity', 'HTML', 'Flash', 'VN', 'QTE']:
            if eng.lower() in full_t.lower() and eng not in tags:
                tags.append(eng)
        
        if tags:
            res['tags'] = tags

        ver_match = re.search(r'\[(v[^\]]+)\]', rest, flags=re.IGNORECASE)
        if ver_match:
            res['latest_version'] = ver_match.group(1).strip()

        dev_matches = re.findall(r'\[([^\]]+)\]', rest)
        if dev_matches and len(dev_matches) > 1:
            res['developer'] = dev_matches[-1].strip()
        elif dev_matches and not ver_match:
            res['developer'] = dev_matches[0].strip()

        clean_t = re.sub(r'\[[^\]]*\]', '', rest).strip()
        clean_t = re.sub(r'^(Completed|VN|RPGM|Unity|3D|2D|Flash|HTML|In Development|On Hold|Abandoned|Collection|Mod|Cheat)\s*[\-\:]\s*', '', clean_t, flags=re.IGNORECASE).strip()
        if clean_t:
            res['title'] = clean_t

    og_desc = soup.find('meta', property='og:description')
    if og_desc and og_desc.get('content'):
        res['description'] = og_desc['content'].strip()[:1000]

    shots = []
    for img in soup.find_all('img'):
        src = img.get('src', '')
        if src.startswith('/'):
            src = "https://f95zone.to" + src
        if 'http' in src and 'favicon' not in src and 'avatar' not in src and 'smilies' not in src and 'logo' not in src:
            if 'attachments.f95zone.to' in src or 'postimg.cc' in src or 'pixhost.to' in src or 'imagebam.com' in src or 'imgbox.com' in src or 'imgur.com' in src:
                clean_src = src.replace('/thumb/', '/')
                if clean_src not in shots:
                    shots.append(clean_src)

    if shots:
        res['cover_url'] = shots[0]
        if len(shots) > 1:
            res['screenshots'] = shots[1:16]
        else:
            res['screenshots'] = shots

    try:
        star_el = soup.find(string=re.compile(r'\d+(\.\d+)?\s*star\(s\)', re.I))
        vote_el = soup.find(string=re.compile(r'\d[\d,]*\s*(Votes|Likes|replies)', re.I))
        if star_el:
            star_val = re.search(r'(\d+(?:\.\d+)?)', star_el.text).group(1)
            if vote_el:
                vote_val = vote_el.text.strip()
                res['rating'] = f"{star_val} / 5 ({vote_val})"
            else:
                res['rating'] = f"{star_val} / 5"
    except Exception:
        pass

    return res

def scrape_itch(url: str) -> Dict[str, Any]:
    res = {}
    if not url:
        return res

    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        if r.status_code != 200:
            return res
        html = r.text
    except Exception:
        return res

    soup = BeautifulSoup(html, 'html.parser')

    og_img = soup.find('meta', property='og:image')
    if og_img and og_img.get('content'):
        res['cover_url'] = og_img['content']

    og_title = soup.find('meta', property='og:title')
    if og_title and og_title.get('content'):
        res['title'] = og_title['content'].split(' by ')[0].strip()
        if ' by ' in og_title['content']:
            res['developer'] = og_title['content'].split(' by ')[-1].strip()
    elif soup.title:
        title_text = soup.title.text.strip()
        res['title'] = title_text.split(' by ')[0].strip()
        if ' by ' in title_text:
            res['developer'] = title_text.split(' by ')[-1].strip()

    og_desc = soup.find('meta', property='og:description')
    if og_desc and og_desc.get('content'):
        res['description'] = og_desc['content'].strip()[:1000]

    shots = []
    for img in soup.find_all('img'):
        src = img.get('src') or img.get('data-lazy_src') or ''
        if 'img.itch.zone' in src and ('original' in src or '/347x/' in src or '/630x/' in src):
            if src != res.get('cover_url') and src not in shots:
                shots.append(src)
    if shots:
        res['screenshots'] = shots[:15]

    try:
        rating_val = soup.find(itemprop="ratingValue") or soup.find(class_="rating_value")
        rating_cnt = soup.find(itemprop="ratingCount") or soup.find(class_="rating_count")
        if rating_val:
            r_str = rating_val.get("content") or rating_val.text.strip()
            r_num = re.search(r'(\d+(?:\.\d+)?)', r_str)
            if r_num and float(r_num.group(1)) > 0:
                if rating_cnt:
                    c_str = rating_cnt.get("content") or rating_cnt.text.strip()
                    c_clean = re.sub(r'[^\d,]', '', c_str)
                    res['rating'] = format_rating(r_num.group(1), c_clean or 0, "reviews")
                else:
                    res['rating'] = format_rating(r_num.group(1))
    except Exception:
        pass

    return res

def fetch_game_metadata(game: Game, db: Session, force_overwrite: bool = True) -> Game:
    data = {}
    if game.source_type == 'f95zone' or (game.source_url and 'f95zone.to' in game.source_url):
        data = scrape_f95zone(game.source_url)
    elif game.source_type == 'dlsite' or (game.source_id and str(game.source_id).upper().startswith(('RJ', 'VJ', 'BJ'))):
        data = scrape_dlsite(game.source_url, game.source_id)
    elif game.source_type == 'itch' or (game.source_url and '.itch.io' in game.source_url):
        data = scrape_itch(game.source_url)

    if not data:
        return game

    if data.get('cover_url') and (force_overwrite or not game.cover_url):
        game.cover_url = data['cover_url']
    if data.get('developer') and (force_overwrite or not game.developer or game.developer == 'Unknown'):
        game.developer = data['developer']
    if data.get('description') and (force_overwrite or not game.description):
        game.description = data['description']
    if data.get('rating') and (force_overwrite or not game.rating or game.rating == 'N/A'):
        game.rating = data['rating']
    current_title_is_code = bool(re.match(r'^[RVB]J\d{6,8}$', str(game.title or ''), re.I))
    if data.get('title') and len(data['title']) > 2:
        if force_overwrite or not game.title or current_title_is_code:
            game.title = data['title']
    if data.get('latest_version'):
        game.latest_version = data['latest_version']
        if game.local_version and game.latest_version != game.local_version:
            game.update_available = True

    if data.get('screenshots'):
        for s in list(game.screenshots):
            db.delete(s)
        for s_url in data['screenshots']:
            game.screenshots.append(Screenshot(game_id=game.id, url=s_url))

    if data.get('tags'):
        existing = [t.tag_name for t in game.tags]
        for t_str in data['tags']:
            if t_str not in existing:
                game.tags.append(Tag(game_id=game.id, tag_name=t_str))

    db.add(game)
    db.commit()
    db.refresh(game)
    return game

def fetch_all_missing_metadata(db: Session) -> int:
    games = db.query(Game).filter(Game.is_identified == True).all()
    count = 0
    for g in games:
        if not g.cover_url or len(g.screenshots) == 0:
            try:
                fetch_game_metadata(g, db, force_overwrite=False)
                count += 1
            except Exception:
                continue
    return count

def rematch_and_scrape_f95zone(db: Session, target_game_id: Optional[int] = None) -> Dict[str, Any]:
    query = db.query(Game)
    if target_game_id:
        games = query.filter(Game.id == target_game_id).all()
    else:
        games = query.all()

    rematched = 0
    scraped = 0
    for g in games:
        # Protect existing valid metadata when running general refresh/rematch (not targeting a single game)
        if not target_game_id and g.is_identified and g.cover_url and g.title and not re.match(r'^[RVB]J\d{6,8}$', str(g.title), re.I):
            if len(g.screenshots) == 0:
                try:
                    fetch_game_metadata(g, db, force_overwrite=False)
                    scraped += 1
                except Exception:
                    pass
            continue

        # Check for DLsite RJ/VJ/BJ code in raw_name, folder_path, title, or source_id
        text_to_check = f"{g.raw_name or ''} {g.folder_path or ''} {g.title or ''} {g.source_id or ''}"
        rj_match = re.search(r'([RVB]J\d{6,8})', text_to_check, flags=re.IGNORECASE)
        
        if rj_match or (g.source_type == 'dlsite' and g.source_id and str(g.source_id).upper().startswith(('RJ', 'VJ', 'BJ'))):
            code = rj_match.group(1).upper() if rj_match else str(g.source_id).upper()
            g.source_type = 'dlsite'
            g.source_id = code
            if not g.source_url or 'dlsite.com' not in g.source_url:
                g.source_url = f"https://www.dlsite.com/maniax/work/=/product_id/{code}.html"
            g.is_identified = True
            db.add(g)
            db.commit()
            try:
                fetch_game_metadata(g, db, force_overwrite=True)
                scraped += 1
            except Exception:
                pass
            continue

        # If game was previously assigned 'itch' from bogus CSV fallback or guess, scrub it
        if g.source_type == 'itch':
            g.source_type = 'unknown'
            g.source_url = None
            g.source_id = None
            g.is_identified = False
            g.cover_url = None
            for s in list(g.screenshots):
                db.delete(s)
            db.add(g)
            db.commit()

        # High-precision F95Zone rematching
        clean_title = re.sub(r'(\bv\d+.*|\b\d+b\b|rev\d+|fixed|ver\b.*|\b\d+\b|windows|edition|complete|deluxe|game|part|chapter|english|translated|archive|rar|zip|7z|\bv\d+\b).*', '', g.title or '', flags=re.IGNORECASE).strip()
        clean_title = re.sub(r'[_\-\.\[\]\(\)\{\}]', ' ', clean_title).strip()
        
        raw_clean = ""
        if g.raw_name:
            raw_clean = re.sub(r'(\bv\d+.*|\b\d+b\b|rev\d+|fixed|ver\b.*|\b\d+\b|windows|edition|complete|deluxe|game|part|chapter|english|translated|archive|rar|zip|7z|\bv\d+\b).*', '', g.raw_name, flags=re.IGNORECASE).strip()
            raw_clean = re.sub(r'[_\-\.\[\]\(\)\{\}]', ' ', raw_clean).strip()

        combined_text = f"{clean_title} {raw_clean}"
        words = []
        for w in combined_text.split():
            w_clean = w.strip()
            if len(w_clean) > 2 and w_clean.lower() not in ('zip', '7z', 'rar', 'ver', 'rev', 'exe', 'game', 'part', 'final', 'mod', 'the', 'and', 'for', 'with', 'from', 'complete', 'edition', 'deluxe', 'patched') and w_clean not in words:
                words.append(w_clean)

        if not words:
            words = [g.title.split()[0]] if g.title else ['game']

        best_match = None
        best_score = 0

        # Build high-precision search query from up to 3 distinctive words, falling back to fewer words if no match
        max_attempts = min(3, len(words))
        if max_attempts == 0: max_attempts = 1
        
        for num_words in range(max_attempts, 0, -1):
            if best_match: break
            search_query = " ".join(words[:num_words])
            if num_words == 1 and len(search_query) < 4: continue
            
            try:
                r = requests.get(f"https://f95zone.to/sam/latest_alpha/latest_data.php?cmd=list&cat=games&search={search_query}", headers=HEADERS, timeout=10)
                data_list = r.json().get('msg', {}).get('data', [])
                if isinstance(data_list, list):
                    for item in data_list:
                        t_low = item.get('title', '').lower()
                        # Require strict word overlap
                        score = sum(1 for wd in words if wd.lower() in t_low)
                        if score > best_score:
                            best_score = score
                            best_match = item
                    
                    min_score = max(1, int(len(words) * 0.75)) if len(words) >= 2 else 1
                    if best_match and best_score >= min_score and (best_score >= 2 or len(words) <= 1):
                        break
                    else:
                        best_match = None
                        best_score = 0
            except Exception as e:
                pass
                
        if best_match and best_score >= min_score and (best_score >= 2 or len(words) <= 1):
            g.source_type = 'f95zone'
            g.source_id = str(best_match['thread_id'])
            g.source_url = f"https://f95zone.to/threads/{best_match['thread_id']}/"
            clean_f95_t = re.sub(r'\[[^\]]*\]', '', best_match.get('title', '')).strip()
            clean_f95_t = re.sub(r'^(Completed|VN|RPGM|Unity|3D|2D|Flash|HTML|In Development|On Hold|Abandoned|Collection|Mod|Cheat)\s*[\-\:]\s*', '', clean_f95_t, flags=re.IGNORECASE).strip()
            if clean_f95_t and len(clean_f95_t) > 2:
                g.title = clean_f95_t
            if best_match.get('creator'):
                g.developer = best_match['creator']
            if best_match.get('version'):
                g.latest_version = best_match['version']
            if best_match.get('cover'):
                g.cover_url = best_match['cover']
            if best_match.get('rating') and float(best_match['rating']) > 0:
                likes_val = best_match.get('likes', 0)
                g.rating = format_rating(best_match['rating'], likes_val, "likes")
            g.is_identified = True
            db.add(g)
            db.commit()
            rematched += 1

            try:
                fetch_game_metadata(g, db, force_overwrite=True)
                scraped += 1
            except Exception:
                pass
        else:
            if g.source_type in ('f95zone', 'dlsite') and (not g.cover_url or len(g.screenshots) == 0):
                try:
                    fetch_game_metadata(g, db, force_overwrite=True)
                    scraped += 1
                except Exception:
                    pass

    return {"message": f"Successfully rematched {rematched} games and updated metadata for {scraped} titles.", "rematched": rematched, "scraped": scraped}

def fix_all_titles_and_metadata(db: Session) -> Dict[str, Any]:
    games = db.query(Game).all()
    updated = 0
    rematched = 0
    for g in games:
        if g.title:
            clean_t = re.sub(r'\[[^\]]*\]|\([^\)]*\)', ' ', str(g.title)).strip()
            clean_t = re.sub(r'^(Completed|VN|RPGM|Unity|3D|2D|Flash|HTML|In Development|On Hold|Abandoned|Collection|Mod|Cheat)\s*[\-\:]\s*', '', clean_t, flags=re.IGNORECASE).strip()
            clean_t = re.sub(r'(\bv\d+.*|\b\d+b\b|rev\d+|fixed|ver\b.*|\b\d+\b|windows|edition|complete|deluxe|game|part|chapter|english|translated|archive|rar|zip|7z|\bv\d+\b).*', '', clean_t, flags=re.IGNORECASE).strip()
            clean_t = re.sub(r'[_\-\.\[\]\(\)\{\}]', ' ', clean_t).strip()
            if len(clean_t) > 2 and clean_t != g.title and not re.match(r'^[RVB]J\d{6,8}$', str(g.title), re.I):
                g.title = clean_t
                db.add(g)
                db.commit()

        if g.is_identified and (g.source_url or g.source_id):
            try:
                fetch_game_metadata(g, db, force_overwrite=True)
                updated += 1
            except Exception:
                continue
        else:
            try:
                res = rematch_and_scrape_f95zone(db, target_game_id=g.id)
                if res.get("rematched", 0) > 0 or res.get("scraped", 0) > 0:
                    rematched += 1
            except Exception:
                continue
    return {"message": f"Fixed titles and refetched covers/screenshots for {updated} identified games and rematched {rematched} games.", "updated": updated, "rematched": rematched}


