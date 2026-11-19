"""Offline fixtures for the price research CLI."""
import io
import json
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import research_prices as prices


PRICE = {'kind': 'estimate', 'input_per_1m': {'min': 0.15, 'max': 0.30},
         'output_per_1m': {'min': 0.60, 'max': 1.20},
         'currency': 'USD', 'source_url': 'https://provider.example/price',
         'quote': 'Per million: $0.15 input and $0.60 output; double at peak.',
         'basis': 'The low end fits off-peak calls; budget for the high end at peak.'}
PLAN = {**PRICE, 'kind': 'plan', 'input_per_1m': None, 'output_per_1m': None,
        'currency': None, 'quote': '20 credits per request.'}


class ResearchTests(unittest.TestCase):
    def test_price_shapes(self):
        for record in (PRICE, PLAN, {**PRICE, 'output_per_1m': None},
                       {**PRICE, 'input_per_1m': {'min': 0, 'max': 0}},
                       {**PRICE, 'input_per_1m': {'min': None, 'max': 1}},
                       {**PRICE, 'input_per_1m': {'min': 0.25, 'max': None}},
                       {**PLAN, 'kind': 'unknown', 'source_url': None, 'quote': None}):
            self.assertEqual(prices.validate(record), record)

    def test_reject_bad_evidence_or_units(self):
        for changes in ({'kind': 'plan'}, {'kind': 'unknown'}, {'kind': 'tariff'},
                        {'basis': ' '}, {'currency': None},
                        {'source_url': 'javascript:alert(1)'}, {'source_url': 'https://me@p.example/'},
                        {'source_url': None}, {'quote': None}, {'input_per_1m': -1},
                        {'output_per_1m': float('nan')}, {'output_per_1m': True},
                        {'output_per_1m': '1'}, {'input_per_1m': None, 'output_per_1m': None}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                prices.validate({**PRICE, **changes})

    def test_reject_invalid_ranges(self):
        for bounds in ({'min': 2, 'max': 1}, {'min': -1, 'max': 0}, {'min': 1},
                       {'min': None, 'max': None}, {'min': True, 'max': 2},
                       {'min': 1, 'max': '2'}, {'min': 0, 'max': float('inf')},
                       {'min': float('nan'), 'max': None}):
            with self.subTest(bounds=bounds), self.assertRaises(ValueError):
                prices.validate({**PRICE, 'output_per_1m': bounds})

    @patch('research_prices.HTTPSConnection', autospec=True)
    def test_request_and_response(self, connect):
        conn = connect.return_value
        res = conn.getresponse.return_value
        res.status = 200
        listing = {'provider': 'Test', 'model': 'lab/id:variant', 'plan': 'API'}
        answer = '```json\n' + json.dumps(PRICE) + '\n```'
        res.read.return_value = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': answer}}]}).encode()
        self.assertEqual(prices.research('fixture', 'deepseek-flash', listing), PRICE)
        host = connect.call_args.args[0]
        method, path, body, headers = conn.request.call_args.args
        self.assertEqual((host, method, path), ('api.deepseek.com', 'POST', '/v1/chat/completions'))
        self.assertEqual(headers['Authorization'], 'Bearer fixture')
        payload = json.loads(body)
        self.assertEqual(payload['tools'][0]['type'], 'deepseek_web_search')
        target = json.loads(payload['messages'][-1]['content'])
        self.assertEqual({k: target[k] for k in listing}, listing)
        for bad in [b'not JSON', b'{"choices":[]}', b'{"choices":[{"finish_reason":"length"}]}', b'x' * (1024 * 1024 + 1)]:
            res.read.return_value = bad
            with self.assertRaises(ValueError):
                prices.research('fixture', 'deepseek-flash', listing)
        for status in (307, 401, 429):
            res.status = status
            res.read.reset_mock()
            with self.assertRaisesRegex(ValueError, str(status)):
                prices.research('fixture', 'deepseek-flash', listing)
            res.read.assert_not_called()

    @patch('research_prices.research', return_value=PRICE)
    def test_batch_preserves_listing_and_skips_duplicates(self, research):
        with patch.dict('os.environ', DEEPSEEK_API_KEY='fixture'), patch('sys.argv', [
                'research_prices.py', '--provider', 'Test', 'a', 'a', 'a:free']), redirect_stdout(io.StringIO()) as out:
            prices.main()
        rows = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual([r['model'] for r in rows], ['a', 'a:free'])
        self.assertEqual(research.call_count, 2)
        self.assertNotIn('fixture', out.getvalue())


if __name__ == '__main__':
    unittest.main()
