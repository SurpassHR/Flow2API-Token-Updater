#!/usr/bin/env python3
"""新版 Flow 建项目 RPC（flow.google.com batchexecute）端到端验证 —— 纯标准库，无第三方依赖。

用法:
    python3 flow_create_project.py <session_token> [项目名]

原理（来自 2026-09 真实 HAR 抓包）:
    1) GET  https://labs.google/fx/api/auth/session  (Cookie: __Secure-next-auth.session-token)
       -> {"access_token": "<AT>", "user": {...}}
    2) POST https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=jHPbke
       Content-Type: application/x-www-form-urlencoded;charset=UTF-8
       Origin/Referer: https://flow.google.com/   X-Same-Domain: 1
       body: f.req=[null,"[\"projects/*\",[null,[\"<title>\"]],[null,22]]"]  &  at=<AT>
    3) 响应是标准 batchexecute 包裹，从中取出新项目的 UUID
"""
import json
import re
import sys
import urllib.parse
import urllib.request
import uuid

RPC_ID = "jHPbke"
BATCH_URL = (
    f"https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute"
    f"?rpcids={RPC_ID}&source-path=%2F&hl=en-US&rt=c"
)
SESSION_URL = "https://labs.google/fx/api/auth/session"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
)
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def http(url: str, *, method: str = "GET", headers: dict | None = None, data: bytes | None = None):
    req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status, resp.read().decode("utf-8", "replace")


def st_to_at(st: str) -> tuple[str, dict]:
    status, body = http(
        SESSION_URL,
        headers={
            "Cookie": f"__Secure-next-auth.session-token={st}",
            "User-Agent": UA,
            "Accept": "application/json",
        },
    )
    print(f"[1] session HTTP {status}")
    data = json.loads(body)
    at = data.get("access_token") or (data.get("user") or {}).get("access_token")
    if not at:
        raise SystemExit(f"未取到 access_token，响应: {body[:500]}")
    return at, data


def create_project(at: str, title: str) -> str:
    inner = json.dumps(["projects/*", [None, [title]], [None, 22]], ensure_ascii=False)
    f_req = json.dumps([[RPC_ID, inner, None, "generic"]])
    body = urllib.parse.urlencode({"f.req": f_req, "at": at}).encode()
    status, text = http(
        BATCH_URL,
        method="POST",
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "Origin": "https://flow.google.com",
            "Referer": "https://flow.google.com/",
            "X-Same-Domain": "1",
            "User-Agent": UA,
        },
    )
    print(f"[2] batchexecute HTTP {status}")
    print("    响应:", text[:500].replace("\n", "\\n"))
    ids = UUID_RE.findall(text)
    return ids[0] if ids else ""


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    st = sys.argv[1].strip()
    title = sys.argv[2] if len(sys.argv) > 2 else f"auto-{uuid.uuid4().hex[:6]}"

    at, info = st_to_at(st)
    user = info.get("user") or {}
    print(f"    email={user.get('email')} at_len={len(at)} expires={info.get('expires')}")

    pid = create_project(at, title)
    if pid:
        print(f"\n✅ 建项目成功: project_id={pid}  title={title!r}")
    else:
        print("\n❌ 未解析到 project id —— 看上面的原始响应判断原因（at 失效 / 额外头 / payload 结构差异）")


if __name__ == "__main__":
    main()
