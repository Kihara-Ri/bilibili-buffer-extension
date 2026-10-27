# 扫码只接受B站已核实的passport/account入口；每次attempt独立CookieJar并绑定调用方会话。
# 未扫码、待确认、过期与验证限制必须区分；本模块不会后台无限轮询或把Cookie交给前端。
"""Server-side, caller-driven Bilibili web QR login; no background polling.

Use one long-lived QrLogin per session file. ``transport_factory(jar)`` may
supply an urllib-style QR opener for offline tests; production uses NoRedirect.
status() uses the existing HttpTransport for nav validation.
Each attempt lives for 180 seconds, permits requests every two seconds, and
belongs to a nonempty server-assigned owner. At most eight attempts are active;
the latest 128 attempts retain terminal results/errors until process exit or
capacity eviction. Restarting the process discards all attempts, not credentials.
Never log request URLs, returned scan URLs, cookies, or exception internals.
"""

import copy
import json
import secrets
import threading
import time
from dataclasses import dataclass
from http.cookiejar import CookieJar, DefaultCookiePolicy
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, build_opener

from . import credentials
from .bilibili import BiliClient, BiliError, HttpTransport, NoRedirect, api_data

BASE = 'https://passport.bilibili.com'
GENERATE = BASE + '/x/passport-login/web/qrcode/generate'
POLL = BASE + '/x/passport-login/web/qrcode/poll'
COOKIE_NAMES = frozenset({'SESSDATA', 'DedeUserID', 'DedeUserID__ckMd5', 'bili_jct'})
MESSAGES = {
    'invalid_owner': '需要有效的本机会话标识。',
    'attempt_not_found': '扫码请求不存在或不属于当前会话。',
    'too_many_attempts': '活动扫码请求过多，请稍后重试。',
    'poll_too_soon': '扫码查询间隔至少为两秒。',
    'redirect_refused': '登录接口返回重定向，已停止请求。',
    'rate_limited': 'B站限制请求或要求人工验证，已停止本次扫码。',
    'network_error': '登录网络请求失败，已停止本次请求。',
    'http_error': '登录接口 HTTP 请求失败，已停止本次请求。',
    'invalid_response': '登录接口返回无效数据，已停止本次扫码。',
    'response_too_large': '登录接口返回超出读取上限。',
    'api_error': 'B站登录接口返回业务错误，已停止本次扫码。',
    'auth_required': 'B站登录态已失效，请重新登录。',
    'credential_error': '本机登录文件不可用，无法验证或保存登录态。',
}


def _error(code):
    return BiliError(code, MESSAGES[code])


def _safe_code(exc):
    return exc.code if isinstance(exc, BiliError) and exc.code in MESSAGES else 'api_error'


def _bili_domain(host):
    return host == 'bilibili.com' or host.endswith('.bilibili.com')


class _CookiePolicy(DefaultCookiePolicy):
    def set_ok(self, cookie, request):
        host = urlsplit(request.full_url).hostname or ''
        return (cookie.name in COOKIE_NAMES and _bili_domain(host)
                and _bili_domain(cookie.domain.lstrip('.'))
                and super().set_ok(cookie, request))


def _scan_url(value):
    try:
        if not isinstance(value, str) or any(ord(c) <= 32 or ord(c) == 127 for c in value):
            raise ValueError
        p = urlsplit(value)
        query = parse_qs(p.query, strict_parsing=True)
        passport = (p.netloc in ('passport.bilibili.com', 'passport.bilibili.com:443')
                    and p.path == '/h5-app/passport/login/scan'
                    and len(query.get('key', [])) == 1 and bool(query['key'][0]))
        account = (p.netloc in ('account.bilibili.com', 'account.bilibili.com:443')
                   and p.path == '/h5/account-h5/auth/scan-web'
                   and len(query.get('qrcode_key', [])) == 1 and bool(query['qrcode_key'][0]))
        if not (p.scheme == 'https' and not p.fragment and (passport or account)):
            raise ValueError
    except (ValueError, TypeError):
        raise _error('invalid_response') from None
    return value


def _account(value):
    if (not isinstance(value, dict) or not isinstance(value.get('id'), (str, int))
            or isinstance(value.get('id'), bool) or not str(value['id'])
            or not isinstance(value.get('name'), str)):
        raise _error('invalid_response')
    return {'id': str(value['id']), 'name': value['name']}


@dataclass(repr=False)
class _Attempt:
    owner: str
    expires_at: float
    next_poll: float
    jar: CookieJar
    opener: object
    key: str = ''
    status: str = 'waiting_scan'
    account: dict | None = None
    failure: str | None = None

    def clear(self):
        self.key = ''
        self.jar.clear()
        self.opener = None

    @property
    def active(self):
        return self.status in ('waiting_scan', 'waiting_confirmation') and self.failure is None


class QrLogin:
    def __init__(self, session_path, transport_factory=None, clock=time.time):
        self.session_path = Path(session_path)
        self._factory = transport_factory or (lambda jar: build_opener(NoRedirect()))
        self._clock = clock
        self._attempts = {}
        # Serializes state transitions and credential writes, including concurrent polls.
        self._lock = threading.RLock()

    def _request(self, attempt, url):
        request = Request(url, headers={
            'User-Agent': 'Mozilla/5.0 BilibiliContent/0.1',
            'Referer': 'https://www.bilibili.com/', 'Accept': 'application/json',
        })
        attempt.jar.add_cookie_header(request)
        try:
            with attempt.opener.open(request, timeout=20) as response:
                if 300 <= response.status < 400 or response.geturl() != url:
                    raise _error('redirect_refused')
                if response.status != 200:
                    raise _error('rate_limited' if response.status in (403, 412, 429) else 'http_error')
                attempt.jar.extract_cookies(response, request)
                raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise _error('response_too_large')
            payload = json.loads(raw)
            # -105 is the legacy CAPTCHA requirement; api_data handles newer
            # risk-control codes and v_voucher on the normal data object.
            if isinstance(payload, dict) and payload.get('code') == -105:
                raise _error('rate_limited')
            return api_data(payload)
        except HTTPError as exc:
            code = ('redirect_refused' if 300 <= exc.code < 400 else
                    'rate_limited' if exc.code in (403, 412, 429) else 'http_error')
            exc.close()
            raise _error(code) from None
        except (URLError, TimeoutError, OSError):
            raise _error('network_error') from None
        except (ValueError, TypeError, UnicodeError):
            raise _error('invalid_response') from None
        except BiliError as exc:
            raise _error(_safe_code(exc)) from None

    def _expire(self, attempt):
        if attempt.active and self._clock() >= attempt.expires_at:
            attempt.status = 'expired'
            attempt.clear()

    def start(self, owner: str):
        if not isinstance(owner, str) or not owner.strip() or len(owner) > 512:
            raise _error('invalid_owner')
        with self._lock:
            for attempt in self._attempts.values():
                self._expire(attempt)
            if sum(a.active for a in self._attempts.values()) >= 8:
                raise _error('too_many_attempts')
            now = self._clock()
            jar = CookieJar(policy=_CookiePolicy())
            attempt = _Attempt(owner, now + 180, now + 2, jar, self._factory(jar))
            try:
                data = self._request(attempt, GENERATE)
                url = _scan_url(data.get('url'))
                key = data.get('qrcode_key')
                if not isinstance(key, str) or not key or len(key) > 4096:
                    raise _error('invalid_response')
                attempt.key = key
            except Exception:
                attempt.clear()
                raise
            while len(self._attempts) >= 128:
                oldest = next(k for k, a in self._attempts.items() if not a.active)
                del self._attempts[oldest]
            attempt_id = secrets.token_urlsafe(32)
            self._attempts[attempt_id] = attempt
            return {'attempt_id': attempt_id, 'url': url, 'expires_at': attempt.expires_at,
                    'poll_after_seconds': 2, 'status': 'waiting_scan'}

    def poll(self, attempt_id, owner):
        with self._lock:
            attempt = self._attempts.get(attempt_id) if isinstance(attempt_id, str) else None
            if attempt is None or not isinstance(owner, str) or not secrets.compare_digest(
                    attempt.owner.encode(), owner.encode()):
                raise _error('attempt_not_found')
            self._expire(attempt)
            if attempt.failure:
                raise _error(attempt.failure)
            if attempt.active:
                if self._clock() < attempt.next_poll:
                    raise _error('poll_too_soon')
                try:
                    data = self._request(attempt, POLL + '?' + urlencode({'qrcode_key': attempt.key}))
                    attempt.next_poll = self._clock() + 2
                    self._expire(attempt)
                    if attempt.active:
                        code = data.get('code')
                        if type(code) is not int:
                            raise _error('invalid_response')
                        if code in (86101, 86090):
                            attempt.status = 'waiting_scan' if code == 86101 else 'waiting_confirmation'
                        elif code == 86038:
                            attempt.status = 'expired'
                            attempt.clear()
                        elif code == 0:
                            cookies = {c.name: c.value for c in attempt.jar if not c.is_expired()
                                       and c.name in COOKIE_NAMES and _bili_domain(c.domain.lstrip('.'))}
                            if not cookies.get('SESSDATA'):
                                raise _error('invalid_response')
                            cookie = '; '.join(f'{k}={v}' for k, v in cookies.items())
                            result = credentials.login(cookie, self.session_path)
                            attempt.account = _account(result.get('account'))
                            attempt.status = 'connected'
                            attempt.clear()
                        else:
                            raise _error('rate_limited' if code in (-105, -352, -412, -509) else 'api_error')
                except (BiliError, ValueError, OSError) as exc:
                    attempt.failure = _safe_code(exc) if isinstance(exc, BiliError) else 'credential_error'
                    attempt.clear()
                    raise _error(attempt.failure) from None
            result = {'attempt_id': attempt_id, 'status': attempt.status}
            if attempt.account is not None:
                result['account'] = copy.deepcopy(attempt.account)
            return result

    def status(self):
        """Validate only the explicitly configured session; network errors propagate."""
        with self._lock:
            try:
                if not self.session_path.exists() and not self.session_path.is_symlink():
                    return {'status': 'auth_required'}
                cookie = credentials.read_session(self.session_path)
                account = BiliClient(HttpTransport(cookie)).identity()
                return {'status': 'connected', 'account': _account(account)}
            except BiliError as exc:
                if exc.code == 'auth_required':
                    return {'status': 'auth_required'}
                raise _error(_safe_code(exc)) from None
            except (ValueError, OSError):
                raise _error('credential_error') from None

    def logout(self):
        """只断开本服务的本地会话，不注销用户在其他设备上的 B 站账号。"""
        with self._lock:
            try:
                if self.session_path.is_symlink():
                    raise _error('credential_error')
                self.session_path.unlink(missing_ok=True)
            except OSError:
                raise _error('credential_error') from None
            for attempt in self._attempts.values():
                attempt.status = 'expired'
                attempt.account = None
                attempt.failure = None
                attempt.clear()
            return {'status': 'auth_required'}
