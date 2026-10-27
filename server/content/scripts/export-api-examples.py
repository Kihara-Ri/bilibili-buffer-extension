"""从虚构夹具与真实领域逻辑生成文档示例；不访问网络或私人数据。"""
import argparse
import json
import sys
import tempfile
from pathlib import Path
from datetime import datetime
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]
from helpers import BiliClient, Transport, entry
from bilibili_content import ContentStore, __version__
from bilibili_content.library import Library
from bilibili_content.playback import Playback
from bilibili_content.server import dispatch
import bilibili_content.library as library_module


def generate():
    # 固定观察时间和内存令牌只用于可重复的文档；运行时仍使用真实时钟和随机值。
    observed_at = '2026-10-27T00:00:00+00:00'
    original_now = library_module.now
    library_module.now = lambda: observed_at
    try:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'example.sqlite3'
            store = ContentStore(database)
            try:
                library = Library(store)
                examples = []

                def add(name, method, path, response, request=None):
                    value = {'name': name, 'method': method, 'path': path, 'response_status': 200,
                             'response': response}
                    if request is not None:
                        value['request'] = request
                    examples.append(value)

                add('health', 'GET', '/health', dispatch(store, 'GET', '/health', None))
                add('empty_queue', 'GET', '/v1/queue', library.queue())
                resolved = library.resolve_video(SimpleNamespace(video=lambda bvid: entry()), 'BV1TUno6bEwA')
                add('resolve', 'POST', '/v1/videos/resolve', resolved, {'url': 'BV1TUno6bEwA'})
                work_id = resolved['selected_id']
                sync = library.sync(BiliClient(Transport()))
                add('sync', 'POST', '/v1/watchlater/sync', sync, {'page_size': 20, 'max_pages': 20})
                subtitle = library.collect_subtitle(BiliClient(Transport()), work_id)
                add('subtitle', 'POST', f'/v1/content/{work_id}/subtitles', subtitle, {})
                add('content', 'GET', f'/v1/content/{work_id}', store.get_work(work_id))
                add('queue', 'GET', '/v1/queue', library.queue())
                add('queue_item', 'GET', f'/v1/queue/{work_id}', library.queue()[0])
                add('snapshot', 'GET', '/v1/account-status', library.status())
                # 重新采集以验证 batch 外层与逐条状态；此 transport 仍是内存夹具。
                add('subtitle_batch', 'POST', '/v1/subtitles/collect',
                    {'results': library.collect_subtitles(BiliClient(Transport()), force=True)},
                    {'limit': 5, 'force': True})
                playback = Playback(database, clock=lambda: datetime.fromisoformat(observed_at).timestamp(), resolver=lambda work, quality: {
                    'durl': [{'url': 'https://example.bilivideo.com/synthetic.mp4', 'length': 120000}],
                    'quality': 16, 'format': 'mp4', 'access': 'anonymous'})
                plan = playback.prepare(work_id, quality=32)
                plan['id'] = 'SYNTHETIC-MEDIA-TOKEN'
                plan['url'] = '/v1/media/SYNTHETIC-MEDIA-TOKEN'
                add('playback', 'POST', '/v1/playback', plan, {'work_id': work_id, 'quality': 32})
                add('rule', 'POST', '/v1/rules', store.set_rule('work', work_id, blocked=False),
                    {'scope': 'work', 'target': work_id, 'blocked': False})
                add('capture_list', 'POST', '/v1/captures', library.import_capture({
                    'type': 'watchlater', 'account': {'id': '42', 'name': '测试账号'},
                    'total': 1, 'items': [entry()]}),
                    {'type': 'watchlater', 'account': {'id': '42', 'name': '测试账号'}, 'total': 1, 'items': [entry()]})
                return {'service_version': __version__, 'synthetic': True,
                        'notice': '虚构账号与可控上游；不是用户资料或真实媒体凭据。QR/错误示例见 API.md。',
                        'examples': examples}
            finally:
                store.close()
    finally:
        library_module.now = original_now


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='比较现有文档示例，不写文件')
    parser.add_argument('--output', type=Path, default=ROOT / 'api-examples.json')
    args = parser.parse_args()
    text = json.dumps(generate(), ensure_ascii=False, indent=2) + '\n'
    if args.check:
        if not args.output.exists() or args.output.read_text(encoding='utf-8') != text:
            raise SystemExit('API 示例与当前实现不一致，请重新生成并审阅。')
        print('API 文档示例与当前内容逻辑一致。')
    else:
        args.output.write_text(text, encoding='utf-8')
        print('已生成虚构 API 响应示例。')


if __name__ == '__main__':
    main()
