import os
import re
import sys
import csv
import time
import json
import requests
from bs4 import BeautifulSoup
from pathlib import Path

# Ensure utf-8 output
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

try:
    from backend.config import get_games_dir
    ROOT_DIR = get_games_dir()
except Exception:
    ROOT_DIR = Path(r"D:\Game setups")
OUTPUT_TXT = Path("games_list.txt").resolve()
OUTPUT_CSV = Path("games_report.csv").resolve()

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

def clean_name(name):
    # Check for exact RJ/BJ/VJ code anywhere in string
    rj_match = re.search(r'([R|B|V]J\d{6,8})', name, flags=re.IGNORECASE)
    if rj_match:
        return {"type": "dlsite_id", "value": rj_match.group(1).upper(), "raw": name}
    
    # Check for URLs if any
    url_match = re.search(r'(https?://[^\s]+)', name)
    if url_match:
        return {"type": "url", "value": url_match.group(1), "raw": name}

    # Remove file extensions
    cleaned = re.sub(r'\.(zip|rar|7z|exe|tar|gz|bz2|iso)$', '', name, flags=re.IGNORECASE)
    # Remove square brackets and parentheses content like [FitGirl Repack], (1), (f95), [ENG], etc.
    cleaned = re.sub(r'\[.*?\]|\(.*?\)', ' ', cleaned)
    # Remove version numbers like v1.08, ver.1.2.3, v2.05, rev1, etc.
    cleaned = re.sub(r'\b(v|ver|rev|build|eng|ver\.)[\s\._-]*\d+[\d\._-]*\b', ' ', cleaned, flags=re.IGNORECASE)
    # Remove common words like win, english, eng, ai, append, repacks, etc.
    cleaned = re.sub(r'\b(win|english|eng|ai|append|repack|repacks|x64|x86|pc|final|game|fixed|patched|complete|edition|mod|dlc|dlcs|demo|gog)\b', ' ', cleaned, flags=re.IGNORECASE)
    # Replace underscores, hyphens, and dots with spaces
    cleaned = re.sub(r'[_\-\.]+', ' ', cleaned)
    # Collapse multiple spaces
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    
    return {"type": "search_query", "value": cleaned, "raw": name}

def is_category_folder(folder_name):
    lower = folder_name.lower()
    return any(k in lower for k in ['dlsite', 'itch', 'f95', 'games', 'setups', 'vn', 'visual novel', 'legit'])

def scan_directory():
    results = []
    if not ROOT_DIR.exists():
        print(f"Error: {ROOT_DIR} does not exist.")
        return results

    for item in sorted(os.listdir(ROOT_DIR)):
        item_path = ROOT_DIR / item
        if item_path.is_file():
            if item.lower().endswith(('.zip', '.rar', '.7z', '.iso', '.exe')):
                results.append((str(ROOT_DIR.name), item, clean_name(item)))
        elif item_path.is_dir():
            if is_category_folder(item):
                for subitem in sorted(os.listdir(item_path)):
                    sub_path = item_path / subitem
                    if sub_path.is_file() and subitem.lower().endswith(('.zip', '.rar', '.7z', '.iso', '.exe')):
                        results.append((item, subitem, clean_name(subitem)))
                    elif sub_path.is_dir():
                        results.append((item, subitem, clean_name(subitem)))
            else:
                subfiles = os.listdir(item_path)
                has_archives = any(f.lower().endswith(('.zip', '.rar', '.7z')) for f in subfiles if (item_path / f).is_file())
                if has_archives:
                    for subitem in sorted(subfiles):
                        sub_path = item_path / subitem
                        if sub_path.is_file() and subitem.lower().endswith(('.zip', '.rar', '.7z', '.iso', '.exe')):
                            results.append((item, subitem, clean_name(subitem)))
                        elif sub_path.is_dir():
                            results.append((item, subitem, clean_name(subitem)))
                else:
                    results.append((str(ROOT_DIR.name), item, clean_name(item)))

    return results

def clean_for_compare(s):
    return re.sub(r'[\s\.\-_:\(\)\[\]]+', '', s).lower()

def search_f95(query):
    # Expand camelCase if any
    expanded = re.sub(r'([a-z])([A-Z])', r'\1 \2', query)
    
    stop_words = {'the', 'and', 'for', 'with', 'from', 'in', 'of', 'to', 'a', 'an', 'on', 'my', 'is', 'ch', 'ep', 'mod', 'wt', 'walkthrough', 'chapter', 'episode', 'ver', 'version'}
    words = [w for w in re.split(r'[\s\.\-_]+', expanded) if len(w) > 2 and w.lower() not in stop_words]
    words.sort(key=len, reverse=True)
    
    if not words:
        words = [query]
        
    target_clean = clean_for_compare(expanded)
    
    # Check top 2 longest words across games and mods categories
    for word in words[:2]:
        for cat in ['games', 'mods']:
            try:
                url = f"https://f95zone.to/sam/latest_alpha/latest_data.php?cmd=list&cat={cat}&search={requests.utils.quote(word)}"
                r = requests.get(url, headers=HEADERS, timeout=7)
                data = json.loads(r.text).get('msg', {}).get('data', [])
                for item in data:
                    title = item.get('title', '')
                    item_clean = clean_for_compare(title)
                    # Fuzzy verification
                    if target_clean == item_clean or target_clean in item_clean or item_clean in target_clean:
                        tid = item.get('thread_id')
                        return f"https://f95zone.to/threads/{tid}/"
            except Exception:
                pass
    return None

def search_dlsite(query):
    try:
        url = f"https://www.dlsite.com/home/fsr/=/keyword/{requests.utils.quote(query)}"
        r = requests.get(url, headers=HEADERS, timeout=7)
        soup = BeautifulSoup(r.text, 'html.parser')
        for a in soup.find_all('a', href=True):
            if '/work/=/product_id/RJ' in a['href'] or '/work/=/product_id/BJ' in a['href'] or '/work/=/product_id/VJ' in a['href']:
                m = re.search(r'([R|B|V]J\d{6,8})', a['href'], flags=re.IGNORECASE)
                if m:
                    return m.group(1).upper()
    except Exception:
        pass
    return None

def search_itch(query):
    try:
        url = f"https://itch.io/search?q={requests.utils.quote(query)}"
        r = requests.get(url, headers=HEADERS, timeout=7)
        soup = BeautifulSoup(r.text, 'html.parser')
        for a in soup.find_all('a', href=True):
            if '.itch.io/' in a['href'] and not any(x in a['href'] for x in ['/devlog/', '/community/', 'blog.itch.io', 'itch.io/jam/']):
                return a['href'].split('?')[0]
    except Exception:
        pass
    return None

def search_steam(query):
    try:
        url = f"https://store.steampowered.com/search/?term={requests.utils.quote(query)}"
        r = requests.get(url, headers=HEADERS, timeout=7)
        soup = BeautifulSoup(r.text, 'html.parser')
        for a in soup.find_all('a', href=True):
            if '/app/' in a['href']:
                return a['href'].split('?')[0]
    except Exception:
        pass
    return None

def match_game(category, raw_name, info):
    if info['type'] == 'dlsite_id':
        return {"source": "Direct DLsite ID", "link": info['value']}
    if info['type'] == 'url':
        return {"source": "Direct URL", "link": info['value']}
        
    query = info['value']
    if not query or len(query) < 2:
        return {"source": "Too Short", "link": None}
        
    cat_lower = category.lower()
    
    # 1. DLsite category
    if 'dlsite' in cat_lower:
        res = search_dlsite(query)
        if res: return {"source": "DLsite Search", "link": res}
        words = query.split()
        if len(words) > 3:
            res = search_dlsite(" ".join(words[:3]))
            if res: return {"source": "DLsite Search (Shortened)", "link": res}
        # Try f95zone before itch
        res = search_f95(query)
        if res: return {"source": "f95zone SAM Match", "link": res}
        res = search_itch(query)
        if res: return {"source": "Itch Search Fallback", "link": res}
        return {"source": "Not Found", "link": None}
        
    # 2. f95 / Itch category or general folder
    # Since most games are from f95zone, check f95zone SAM API first!
    res = search_f95(query)
    if res: return {"source": "f95zone SAM Match", "link": res}
    
    if 'itch' in cat_lower:
        res = search_itch(query)
        if res: return {"source": "Itch Search", "link": res}
        res = search_steam(query)
        if res: return {"source": "Steam Search Fallback", "link": res}
        return {"source": "Not Found", "link": None}
        
    # 3. General category fallback
    res = search_steam(query)
    if res: return {"source": "Steam Search", "link": res}
    res = search_dlsite(query)
    if res: return {"source": "DLsite Search", "link": res}
    res = search_itch(query)
    if res: return {"source": "Itch Search", "link": res}
    
    return {"source": "Not Found", "link": None}

def main():
    print("=== Scanning D:\\Game setups ===")
    items = scan_directory()
    print(f"Total game entries discovered: {len(items)}")
    
    unique_links = set()
    csv_rows = []
    
    print("\nStarting online matching with f95zone SAM prioritization...")
    for idx, (category, raw_name, info) in enumerate(items, 1):
        res = match_game(category, raw_name, info)
        link = res["link"]
        source = res["source"]
        
        print(f"[{idx}/{len(items)}] [{category}] {raw_name} -> {link if link else 'NO MATCH'} ({source})")
        
        if link and link not in unique_links:
            unique_links.add(link)
            
        csv_rows.append({
            "Category": category,
            "Local Folder/File": raw_name,
            "Cleaned Query": info["value"],
            "Match Source": source,
            "Import Link / ID": link if link else ""
        })
        time.sleep(0.2)
            
    # Write TXT
    with open(OUTPUT_TXT, "w", encoding="utf-8") as f:
        for link in sorted(unique_links):
            f.write(f"{link}\n")
            
    # Write CSV
    with open(OUTPUT_CSV, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["Category", "Local Folder/File", "Cleaned Query", "Match Source", "Import Link / ID"])
        writer.writeheader()
        writer.writerows(csv_rows)
        
    print("\n=== COMPLETE ===")
    print(f"Successfully generated {len(unique_links)} unique importable links/IDs!")
    print(f"1. Bulk Import File: {OUTPUT_TXT}")
    print(f"2. Detailed Verification Report: {OUTPUT_CSV}")

if __name__ == "__main__":
    main()
