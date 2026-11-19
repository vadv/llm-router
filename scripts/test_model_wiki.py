import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import sys
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

import research_prices as prices
from wiki_preview import render


EXAMPLES = Path(__file__).with_name('examples') / 'model-wiki.jsonl'
CARD = json.loads(EXAMPLES.read_text(encoding='utf-8').splitlines()[0])


def preview(card):
    return render(io.BytesIO(json.dumps(card).encode() + b'\n'))


class WikiTests(unittest.TestCase):
    def test_two_model_examples(self):
        with EXAMPLES.open('rb') as file:
            html = render(file)
        self.assertIn('Relace Apply 3', html)
        self.assertIn('Moondream 3.1', html)
        self.assertIn('≈ 0.85', html)
        self.assertIn('Редакторский пример', html)
        self.assertNotIn('<script', html)

    def test_evidence_is_validated_and_text_escaped(self):
        rating = {'metric': '<svg>', 'result': '12% · test split', 'source_url': 'https://example.com/report'}
        html = preview({**CARD, 'model': '<img src=x>', 'ratings': [rating]})
        self.assertIn('&lt;img src=x&gt;', html)
        self.assertIn('&lt;svg&gt;', html)
        for fields in ({'scope': 'listing'}, {'try_this': ' '}, {'strengths': 'good'}, {'sources': []},
                       {'sources': ['https://good.example\\@bad.example']}, {'ratings': [1]},
                       {'ratings': [{**rating, 'source_url': 'javascript:alert(1)'}]}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                preview({**CARD, **fields})

    def test_reference_price_is_not_a_route_tariff(self):
        price = CARD['price']
        for input_range, output_range, expected in [({'min': 0.1, 'max': 0.4}, None, '≈ 0.1–0.4'),
                                                     ({'min': 0.15, 'max': None}, None, 'от 0.15'),
                                                     (None, {'min': None, 'max': 1}, 'до 1')]:
            html = preview({**CARD, 'price': {**price, 'input_per_1m': input_range, 'output_per_1m': output_range}})
            self.assertIn(expected, html)
            self.assertIn('нет оценки', html)
        for kind, label in [('unknown', 'Нет обоснованной оценки'), ('plan', 'Тарификация по плану')]:
            html = preview({**CARD, 'price': {**price, 'kind': kind, 'currency': None,
                                               'input_per_1m': None, 'output_per_1m': None}})
            self.assertIn(label, html)
            self.assertNotIn('USD за 1 млн', html)

    @patch('research_prices.HTTPSConnection', autospec=True)
    def test_live_mode_with_offline_http_fixture(self, connect):
        conn = connect.return_value
        res = conn.getresponse.return_value
        res.status = 200
        res.read.return_value = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(CARD)}}]}).encode()
        with patch.dict('os.environ', DEEPSEEK_API_KEY='fixture'), patch.object(sys, 'argv', ['poc', '--wiki', 'example', 'example']), redirect_stdout(io.StringIO()) as out:
            prices.main()
        conn.request.assert_called_once()
        body = json.loads(conn.request.call_args.args[2])
        self.assertEqual(body['messages'][0]['content'], prices.WIKI_PROMPT)
        target = json.loads(body['messages'][1]['content'])
        self.assertEqual(set(target), {'model', 'scope', 'as_of'})
        card = json.loads(out.getvalue())
        self.assertEqual(card['researcher'], 'deepseek-flash')
        self.assertIn('Когда выбирать', preview(card))

    @patch('research_prices.HTTPSConnection', autospec=True)
    def test_no_wiki_card_preserves_exact_answer_without_retry(self, connect):
        conn = connect.return_value
        response = conn.getresponse.return_value
        response.status = 200
        for content, error in [("I'll research this model using multiple search angles.", 'no JSON'),
                               ('{"status":"no_model_source"}', 'no source for the exact model')]:
            with self.subTest(content=content), TemporaryDirectory() as folder:
                conn.reset_mock()
                path = Path(folder) / 'raw.txt'
                response.read.return_value = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': content}}]}).encode()
                with self.assertRaisesRegex(ValueError, error):
                    prices.research('fixture', 'deepseek-flash', {'scope': 'model_wiki', 'model': 'MiMo-V2.6-Pro'}, raw_path=path)
                self.assertEqual(path.read_text(), content)
                conn.request.assert_called_once()

    @patch('research_prices.HTTPSConnection')
    def test_modes_and_preview_limits(self, connect):
        for flags in (['--wiki', '--plan', 'API'], ['--wiki', '--provider', 'Test']):
            with patch.object(sys, 'argv', ['poc', *flags, 'example']), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                prices.main()
        connect.assert_not_called()
        for data in [b'', b'x' * 65537]:
            with self.assertRaises(ValueError):
                render(io.BytesIO(data))


if __name__ == '__main__':
    unittest.main()
