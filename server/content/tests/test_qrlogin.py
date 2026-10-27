import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
"""Offline QR protocol tests: real state machine and CookieJar, fake HTTP only."""
import io
import json
import tempfile
from concurrent.futures import ThreadPoolExecutor
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from bilibili_content.bilibili import BiliError
from bilibili_content import qrlogin

SCAN = 'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrloginfrom=web&source=main-fe-header&gourl=https%3A%2F%2Fwww.bilibili.com&key=SCAN_SECRET'
GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=POLL_SECRET'
ACCOUNT = {'id': '42', 'name': '测试账号'}


class Response(io.BytesIO):
    def __init__(self, data, cookies=(), url=None, status=200):
        super().__init__(json.dumps(data).encode())
        self.headers = Message()
        for cookie in cookies:
            self.headers.add_header('Set-Cookie', cookie)
        self.url, self.status = url, status

    def info(self):
        return self.headers

    def geturl(self):
        return self.url


class HTTP:
    def __init__(self):
        self.responses = []
        self.requests = []
        self.jars = []

    def factory(self, jar):
        self.jars.append(jar)
        return self

    def open(self, request, timeout):
        self.requests.append(request)
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        if result.url is None:
            result.url = request.full_url
        return result

    def generated(self, url=SCAN):
        self.responses.append(Response({'code': 0, 'data': {'url': url, 'qrcode_key': 'POLL_SECRET'}}))

    def polled(self, code, cookies=(), **data):
        self.responses.append(Response({'code': 0, 'data': {'code': code, **data}}, cookies))


class QrLoginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'private' / 'session.json'
        self.now = 1000
        self.http = HTTP()
        self.service = qrlogin.QrLogin(self.path, self.http.factory, lambda: self.now)
        self.saved = []

        def save(cookie, path):
            self.saved.append((cookie, path))
            return {'account': ACCOUNT, 'cookie': 'DO_NOT_RETURN', 'session_file': str(path)}
        patcher = patch.object(qrlogin.credentials, 'login', side_effect=save)
        self.login = patcher.start()
        self.addCleanup(patcher.stop)

    def start(self, owner='alice'):
        self.http.generated()
        return self.service.start(owner)

    def poll(self, attempt, owner='alice'):
        self.now += 2
        return self.service.poll(attempt['attempt_id'], owner)

    def error(self, code, action):
        with self.assertRaises(BiliError) as caught:
            action()
        self.assertEqual(caught.exception.code, code)
        for secret in ('POLL_SECRET', 'SCAN_SECRET', 'COOKIE_SECRET', 'REFRESH_SECRET'):
            self.assertNotIn(secret, str(caught.exception))
        return caught.exception

    def test_start_and_state_machine_success_is_idempotent_and_private(self):
        a = self.start()
        self.assertEqual(set(a), {'attempt_id', 'url', 'expires_at', 'poll_after_seconds', 'status'})
        self.assertEqual((a['status'], a['expires_at'], a['poll_after_seconds']), ('waiting_scan', 1180, 2))
        self.assertEqual(a['url'], SCAN)
        self.assertGreaterEqual(len(a['attempt_id']), 32)
        for code, status in ((86101, 'waiting_scan'), (86090, 'waiting_confirmation')):
            self.http.polled(code)
            self.assertEqual(self.poll(a), {'attempt_id': a['attempt_id'], 'status': status})
        self.http.polled(0, ['SESSDATA=COOKIE_SECRET; Domain=.bilibili.com; Path=/; Secure; HttpOnly',
                             'bili_jct=CSRF; Domain=.bilibili.com; Path=/; Secure',
                             'refresh_token=REFRESH_SECRET; Domain=.bilibili.com; Path=/',
                             'DedeUserID=EVIL; Domain=evil.com; Path=/',
                             'DedeUserID__ckMd5=EVIL; Domain=bilibili.com.evil.com; Path=/'],
                         url='https://evil.com/?SESSDATA=IGNORED', refresh_token='REFRESH_SECRET')
        result = self.poll(a)
        self.assertEqual(result, {'attempt_id': a['attempt_id'], 'status': 'connected', 'account': ACCOUNT})
        self.assertEqual(self.saved, [('SESSDATA=COOKIE_SECRET; bili_jct=CSRF', self.path)])
        result['account']['name'] = 'mutated'
        self.now += 1000
        self.assertEqual(self.service.poll(a['attempt_id'], 'alice')['account'], ACCOUNT)
        self.assertEqual(len(self.saved), 1)
        self.assertEqual([r.full_url for r in self.http.requests], [GENERATE, POLL, POLL, POLL])
        self.assertTrue(all(r.get_method() == 'GET' for r in self.http.requests))
        self.assertEqual(len(self.http.jars[0]), 0)

    def test_owner_unknown_and_minimum_interval_do_not_request_http(self):
        a = self.start()
        self.error('attempt_not_found', lambda: self.service.poll(a['attempt_id'], 'bob'))
        self.error('attempt_not_found', lambda: self.service.poll('unknown', 'alice'))
        self.error('poll_too_soon', lambda: self.service.poll(a['attempt_id'], 'alice'))
        self.assertEqual(len(self.http.requests), 1)
        self.http.polled(86101)
        self.poll(a)
        self.error('poll_too_soon', lambda: self.service.poll(a['attempt_id'], 'alice'))
        self.assertEqual(len(self.http.requests), 2)

    def test_local_and_remote_expiry_are_terminal(self):
        for remote in (False, True):
            a = self.start()
            if remote:
                self.http.polled(86038)
            else:
                self.now += 180
            self.assertEqual(self.poll(a)['status'], 'expired')
            count = len(self.http.requests)
            self.assertEqual(self.service.poll(a['attempt_id'], 'alice')['status'], 'expired')
            self.assertEqual(len(self.http.requests), count)
        self.assertEqual(self.saved, [])

    def test_active_limit_and_isolated_attempt_cookies(self):
        attempts = [self.start() for _ in range(8)]
        self.assertEqual(len({a['attempt_id'] for a in attempts}), 8)
        self.assertEqual(len({id(j) for j in self.http.jars}), 8)
        self.error('too_many_attempts', lambda: self.service.start('bob'))
        self.now += 180
        self.start('bob')

    def test_unsafe_scan_urls_are_never_returned(self):
        for url in ('http://passport.bilibili.com/h5-app/passport/login/scan?key=x',
                    'https://evil.com/', 'https://passport.bilibili.com.evil.com/',
                    'https://user@passport.bilibili.com/h5-app/passport/login/scan?key=x',
                    'https://passport.bilibili.com:444/h5-app/passport/login/scan?key=x',
                    'https://passport.bilibili.com/redirect?key=x', SCAN + '#fragment',
                    SCAN + '\n', None):
            with self.subTest(url=url):
                self.http.generated(url)
                self.error('invalid_response', lambda: self.service.start('alice'))

    def test_invalid_owner_never_requests(self):
        for owner in ('', ' ', None, 42):
            self.error('invalid_owner', lambda: self.service.start(owner))
        self.assertEqual(self.http.requests, [])

    def test_current_account_scan_endpoint_is_accepted_without_poll_key_exposure(self):
        url = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=https%3A%2F%2Fwww.bilibili.com&qrcode_key=SCAN_SECRET'
        self.http.generated(url)
        result = self.service.start('alice')
        self.assertEqual(result['url'], url)
        self.assertNotIn('qrcode_key', result)
        self.assertNotIn('POLL_SECRET', str(result))

    def test_logout_removes_only_local_session_and_expires_pending_attempts(self):
        attempt = self.start()
        self.path.parent.mkdir()
        self.path.write_text('TEST_LOCAL_SESSION')
        result = self.service.logout()
        self.assertEqual(result, {'status': 'auth_required'})
        self.assertFalse(self.path.exists())
        count = len(self.http.requests)
        self.assertEqual(self.poll(attempt)['status'], 'expired')
        self.assertEqual(len(self.http.requests), count)
        self.assertEqual(self.service.logout(), {'status': 'auth_required'})

    def test_errors_are_classified_sanitized_and_stop_attempt(self):
        cases = [(HTTPError(POLL, c, 'COOKIE_SECRET', {}, None), 'rate_limited') for c in (403, 412, 429)]
        cases += [(HTTPError(POLL, 500, 'secret', {}, None), 'http_error'),
                  (URLError(POLL), 'network_error'),
                  (Response({'code': -352, 'message': POLL}), 'rate_limited'),
                  (Response({'code': 0, 'data': {'code': 0, 'v_voucher': 'secret'}}), 'rate_limited'),
                  (Response({'code': 0, 'data': {'code': 123, 'message': POLL}}), 'api_error'),
                  (Response({'code': 0, 'data': {'code': True}}), 'invalid_response'),
                  (Response({'code': 0, 'data': {'code': 0}}), 'invalid_response')]
        for response, code in cases:
            with self.subTest(code=code, response=type(response)):
                a = self.start()
                self.http.responses.append(response)
                self.error(code, lambda: self.poll(a))
                count = len(self.http.requests)
                self.error(code, lambda: self.poll(a))
                self.assertEqual(len(self.http.requests), count)
        self.assertEqual(self.saved, [])

    def test_redirect_and_foreign_final_response_are_refused(self):
        for response in (HTTPError(GENERATE, 302, 'redirect', {'Location': 'https://evil.com'}, None),
                         Response({'code': 0, 'data': {}}, url='https://evil.com'),
                         Response({'code': 0, 'data': {}}, status=302)):
            self.http.responses.append(response)
            self.error('redirect_refused', lambda: self.service.start('alice'))
        handler = qrlogin.NoRedirect()
        self.error('redirect_refused', lambda: handler.redirect_request(None, None, 302, '', {}, 'https://evil.com'))

    def test_no_cross_attempt_cookie_and_success_needs_legal_session_cookie(self):
        a, b = self.start(), self.start('bob')
        self.http.polled(86101, ['SESSDATA=COOKIE_SECRET; Domain=.bilibili.com; Path=/; Secure'])
        self.poll(a)
        self.http.polled(0, ['SESSDATA=EVIL; Domain=evil.com; Path=/'])
        self.error('invalid_response', lambda: self.poll(b, 'bob'))
        self.assertIsNone(self.http.requests[-1].get_header('Cookie'))
        self.http.polled(0)
        self.assertEqual(self.poll(a)['status'], 'connected')
        self.assertIn('COOKIE_SECRET', self.http.requests[-1].get_header('Cookie'))

    def test_verification_failure_is_terminal_and_sanitized(self):
        a = self.start()
        self.http.polled(0, ['SESSDATA=COOKIE_SECRET; Domain=.bilibili.com; Path=/'])
        self.login.side_effect = BiliError('network_error', POLL)
        self.error('network_error', lambda: self.poll(a))
        self.error('network_error', lambda: self.poll(a))
        self.assertEqual(self.login.call_count, 1)

    def test_captcha_business_codes_stop_without_retry(self):
        for root in (True, False):
            a = self.start()
            payload = {'code': -105} if root else {'code': 0, 'data': {'code': -105}}
            self.http.responses.append(Response(payload))
            self.error('rate_limited', lambda: self.poll(a))
            self.error('rate_limited', lambda: self.poll(a))

    def test_concurrent_success_verifies_and_saves_once(self):
        a = self.start()
        self.now += 2
        self.http.polled(0, ['SESSDATA=COOKIE_SECRET; Domain=.bilibili.com; Path=/'])
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.service.poll(a['attempt_id'], 'alice'), range(4)))
        self.assertTrue(all(r['status'] == 'connected' for r in results))
        self.assertEqual(len(self.saved), 1)
        self.assertEqual(len(self.http.requests), 2)

    def test_bad_json_size_and_key_fail_safely(self):
        for payload, code in ((b'not JSON POLL_SECRET', 'invalid_response'),
                              (b'x' * (1024 * 1024 + 1), 'response_too_large')):
            a = self.start()
            response = Response({})
            response.seek(0)
            response.write(payload)
            response.seek(0)
            self.http.responses.append(response)
            self.error(code, lambda: self.poll(a))
            self.error(code, lambda: self.poll(a))
        for data in ({'url': SCAN}, {'url': SCAN, 'qrcode_key': 42}):
            self.http.responses.append(Response({'code': 0, 'data': data}))
            self.error('invalid_response', lambda: self.service.start('alice'))

    def test_response_arriving_after_deadline_cannot_save(self):
        a = self.start()
        self.now += 2
        self.http.polled(0, ['SESSDATA=COOKIE_SECRET; Domain=.bilibili.com; Path=/'])
        original = self.http.open

        def delayed(request, timeout):
            self.now += 180
            return original(request, timeout)
        self.http.open = delayed
        self.assertEqual(self.service.poll(a['attempt_id'], 'alice')['status'], 'expired')
        self.assertEqual(self.saved, [])

    def test_status_reads_only_explicit_temporary_session_and_validates_nav(self):
        self.assertEqual(self.service.status(), {'status': 'auth_required'})
        self.path.parent.mkdir(mode=0o700)
        self.path.write_text(json.dumps({'cookie': 'SESSDATA=TEMP_ONLY'}))
        self.path.chmod(0o600)
        with patch('bilibili_content.bilibili.build_opener', return_value=self.http):
            self.http.responses.append(Response({'code': 0, 'data': {'isLogin': True, 'mid': 42, 'uname': '测试账号'}}))
            self.assertEqual(self.service.status(), {'status': 'connected', 'account': ACCOUNT})
            self.assertEqual(self.http.requests[-1].full_url, 'https://api.bilibili.com/x/web-interface/nav')
            self.http.responses.append(Response({'code': -101}))
            self.assertEqual(self.service.status(), {'status': 'auth_required'})
            self.http.responses.append(URLError('COOKIE_SECRET'))
            self.error('network_error', self.service.status)
        self.path.chmod(0o644)
        self.error('credential_error', self.service.status)


if __name__ == '__main__':
    unittest.main()
