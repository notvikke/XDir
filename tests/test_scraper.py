import unittest
import urllib.parse
from unittest.mock import patch

from backend.scraper import scrape_dlsite, search_f95zone


class _FakeResponse:
    def __init__(self, status_code=200, text="", json_data=None):
        self.status_code = status_code
        self.text = text
        self._json_data = json_data

    def json(self):
        return self._json_data


def _sam_response(items):
    return _FakeResponse(json_data={"msg": {"data": items}})


class DlsiteScraperTests(unittest.TestCase):
    @patch("backend.scraper.requests.get")
    def test_scrape_dlsite_html_fallback_collects_screenshots_from_data_src(self, mock_get):
        html = """
        <html>
            <head>
                <meta property="og:image" content="https://img.dlsite.jp/modpub/images2/work/doujin/RJ01365000/RJ01364173_img_main.jpg">
                <meta property="og:title" content="Test Title | DLsite">
            </head>
            <body>
                <div class="product-slider-data">
                    <div data-src="//img.dlsite.jp/modpub/images2/work/doujin/RJ01365000/RJ01364173_img_main.jpg"></div>
                    <div data-src="//img.dlsite.jp/modpub/images2/work/doujin/RJ01365000/RJ01364173_img_smp1.jpg"></div>
                    <div data-src="//img.dlsite.jp/modpub/images2/work/doujin/RJ01365000/RJ01364173_img_smp2.jpg"></div>
                    <div data-src="//img.dlsite.jp/modpub/images2/work/doujin/RJ01365000/RJ01364173_img_smp3.jpg"></div>
                </div>
            </body>
        </html>
        """

        def fake_get(url, headers=None, timeout=None):
            if "/api/=/product.json" in url:
                return _FakeResponse(
                    json_data=[
                        {
                            "workno": "VJ01006520",
                            "image_main": {"url": "//img.dlsite.jp/modpub/images2/work/professional/VJ01007000/VJ01006520_img_main.jpg"},
                            "image_samples": [
                                {"url": "//img.dlsite.jp/modpub/images2/work/professional/VJ01007000/VJ01006520_img_smpa1.jpg"}
                            ],
                        }
                    ]
                )
            return _FakeResponse(status_code=200, text=html)

        mock_get.side_effect = fake_get

        result = scrape_dlsite("", "RJ01364173")

        self.assertEqual(
            result["cover_url"],
            "https://img.dlsite.jp/modpub/images2/work/doujin/RJ01365000/RJ01364173_img_main.jpg",
        )
        self.assertEqual(
            result["screenshots"],
            [
                "https://img.dlsite.jp/modpub/images2/work/doujin/RJ01365000/RJ01364173_img_smp1.jpg",
                "https://img.dlsite.jp/modpub/images2/work/doujin/RJ01365000/RJ01364173_img_smp2.jpg",
                "https://img.dlsite.jp/modpub/images2/work/doujin/RJ01365000/RJ01364173_img_smp3.jpg",
            ],
        )


class F95ZoneSearchTests(unittest.TestCase):
    @patch("backend.scraper.requests.get")
    def test_search_retries_with_a_normalized_possessive_title(self, mock_get):
        target = {
            "thread_id": 12345,
            "title": "My wife\u2019s most beautiful side",
            "version": "Final",
            "creator": "otetudou",
            "cover": "https://example.com/target.jpg",
        }
        noise = {
            "thread_id": 67890,
            "title": "The Reason My Wife Has Gotten More Beautiful",
            "version": "v1.0",
            "creator": "Another developer",
            "cover": "",
        }

        def fake_get(url, headers=None, timeout=None):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["search"][0]
            if query == "My wife's most beautiful side":
                return _sam_response([])
            if query == "My wife most beautiful side":
                return _sam_response([noise, target])
            return _sam_response([])

        mock_get.side_effect = fake_get

        results = search_f95zone("My wife's most beautiful side")

        self.assertEqual(results[0]["title"], target["title"])
        self.assertEqual(results[0]["source_id"], "12345")
        requested_queries = [
            urllib.parse.parse_qs(urllib.parse.urlparse(call.args[0]).query)["search"][0]
            for call in mock_get.call_args_list
        ]
        self.assertEqual(
            requested_queries,
            ["My wife's most beautiful side", "My wife most beautiful side"],
        )

    @patch("backend.scraper.requests.get")
    def test_search_removes_edge_stopwords_and_ranks_the_best_partial_title(self, mock_get):
        other = {
            "thread_id": 111,
            "title": "Help!!! I Got Lost and Found a Village That's Full of... Monsters!",
            "version": "v0.1",
            "creator": "Other developer",
            "cover": "",
        }
        target = {
            "thread_id": 222,
            "title": "I Got Lost in an All-Female Elf Village and Can't Leave Until I've Impregnated Everyone",
            "version": "Final",
            "creator": "Target developer",
            "cover": "https://example.com/target.jpg",
        }

        def fake_get(url, headers=None, timeout=None):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["search"][0]
            if query == "Got Lost":
                return _sam_response([other, target])
            return _sam_response([])

        mock_get.side_effect = fake_get

        results = search_f95zone("I Got Lost in")

        self.assertEqual(results[0]["source_id"], "222")
        requested_queries = [
            urllib.parse.parse_qs(urllib.parse.urlparse(call.args[0]).query)["search"][0]
            for call in mock_get.call_args_list
        ]
        self.assertEqual(requested_queries, ["I Got Lost in", "Got Lost"])

    @patch("backend.scraper.requests.get")
    def test_search_normalizes_hyphenated_title_fragments(self, mock_get):
        target = {
            "thread_id": 222,
            "title": "I Got Lost in an All-Female Elf Village and Can't Leave Until I've Impregnated Everyone",
            "version": "Final",
            "creator": "Target developer",
            "cover": "",
        }

        def fake_get(url, headers=None, timeout=None):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["search"][0]
            if query == "All Female Elf Village":
                return _sam_response([target])
            return _sam_response([])

        mock_get.side_effect = fake_get

        results = search_f95zone("All-Female Elf Village")

        self.assertEqual(results[0]["source_id"], "222")
        requested_queries = [
            urllib.parse.parse_qs(urllib.parse.urlparse(call.args[0]).query)["search"][0]
            for call in mock_get.call_args_list
        ]
        self.assertEqual(
            requested_queries,
            ["All-Female Elf Village", "All Female Elf Village"],
        )


if __name__ == "__main__":
    unittest.main()
