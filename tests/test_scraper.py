import unittest
from unittest.mock import patch

from backend.scraper import scrape_dlsite


class _FakeResponse:
    def __init__(self, status_code=200, text="", json_data=None):
        self.status_code = status_code
        self.text = text
        self._json_data = json_data

    def json(self):
        return self._json_data


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


if __name__ == "__main__":
    unittest.main()
