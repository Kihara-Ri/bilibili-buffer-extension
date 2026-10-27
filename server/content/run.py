"""从仓库直接启动，无需安装或启动 Chrome 扩展。"""

from pathlib import Path

from bilibili_content.cli import main

if __name__ == "__main__":
    raise SystemExit(main(default_data=Path(__file__).resolve().parent / "data"))
