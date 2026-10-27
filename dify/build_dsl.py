"""Generate the importable Dify 1.9.2 workflow from the reviewed game rules."""

from pathlib import Path

import yaml


ROOT = Path(__file__).parent


def node(identifier, kind, title, x, **data):
    return {
        "id": identifier,
        "type": "custom",
        "position": {"x": x, "y": 240},
        "positionAbsolute": {"x": x, "y": 240},
        "width": 244,
        "height": 90,
        "sourcePosition": "right",
        "targetPosition": "left",
        "data": {"type": kind, "title": title, "desc": "", "selected": False, **data},
    }


def build():
    start = node(
        "start",
        "start",
        "选择行动",
        0,
        variables=[
            {
                "variable": "player",
                "label": "玩家编号（跨会话保持相同）",
                "type": "text-input",
                "required": True,
                "max_length": 64,
                "options": [],
            },
            {
                "variable": "action",
                "label": "这一次，你怎么做？",
                "type": "select",
                "required": True,
                "options": ["观察", "借伞", "还伞", "偷铃", "道歉", "回到昨天", "敲铃"],
            },
        ],
    )
    http = {
        "authorization": {"type": "no-auth", "config": None},
        "headers": "Authorization:Bearer {{#env.STORE_TOKEN#}}\nContent-Type:application/json",
        "params": "",
        "timeout": {"connect": 10, "read": 60, "write": 30},
        "retry_config": {
            "retry_enabled": False,
            "max_retries": 1,
            "retry_interval": 1000,
        },
        "ssl_verify": True,
        "variables": [],
    }
    recall = node(
        "recall",
        "http-request",
        "读取店主的记忆",
        310,
        method="get",
        url="{{#env.STORE_URL#}}/players/{{#start.player#}}",
        body={"type": "none", "data": []},
        **http,
    )
    rules = node(
        "rules",
        "code",
        "时间循环与选择规则",
        620,
        code_language="python3",
        code=(ROOT / "engine.py").read_text(),
        variables=[
            {
                "variable": "snapshot",
                "value_selector": ["recall", "body"],
                "value_type": "string",
            },
            {
                "variable": "action",
                "value_selector": ["start", "action"],
                "value_type": "string",
            },
            {
                "variable": "request_id",
                "value_selector": ["sys", "workflow_run_id"],
                "value_type": "string",
            },
        ],
        outputs={
            "transition": {"type": "string", "children": None},
            "story": {"type": "string", "children": None},
        },
    )
    commit = node(
        "commit",
        "http-request",
        "把本次选择写入 PowerContext",
        930,
        method="post",
        url="{{#env.STORE_URL#}}/players/{{#start.player#}}/commit",
        body={
            "type": "raw-text",
            "data": [{"type": "text", "key": "", "value": "{{#rules.transition#}}"}],
        },
        **http,
    )
    narrate = node(
        "narrate",
        "http-request",
        "根据往事即兴生成店主台词",
        1240,
        method="post",
        url="{{#env.STORE_URL#}}/narrate",
        body={
            "type": "raw-text",
            "data": [
                {
                    "type": "text",
                    "key": "",
                    "value": '{"saved":{{#commit.body#}},"past":{{#recall.body#}}}',
                }
            ],
        },
        **http,
    )
    render = node(
        "render",
        "code",
        "呈现剧情与记忆回声",
        1550,
        code_language="python3",
        variables=[
            {
                "variable": "body",
                "value_selector": ["commit", "body"],
                "value_type": "string",
            },
            {
                "variable": "status",
                "value_selector": ["commit", "status_code"],
                "value_type": "number",
            },
            {
                "variable": "narration",
                "value_selector": ["narrate", "body"],
                "value_type": "string",
            },
        ],
        code="""import json

def main(body: str, status: int, narration: str) -> dict:
    if status != 200:
        raise ValueError("记忆没有保存成功，请刷新重试。HTTP " + str(status))
    saved = json.loads(body)
    event = saved["event"]
    state = event["state"]
    text = "第 " + str(state["day"]) + " 个昨天\\n\\n" + event["story"]
    voice = json.loads(narration)
    text += "\\n\\n店主的话：" + voice["flavor"]
    if event["choices"]:
        text += "\\n\\n接下来：" + " / ".join(event["choices"])
    return {"answer": text, "memory_receipt": json.dumps(saved["citation"], ensure_ascii=False), "state": json.dumps(state, ensure_ascii=False), "model_used": str(voice["used_model"]).lower()}
""",
        outputs={
            name: {"type": "string", "children": None}
            for name in ["answer", "memory_receipt", "state", "model_used"]
        },
    )
    end = node(
        "end",
        "end",
        "店主的回答",
        1860,
        outputs=[
            {
                "variable": name,
                "value_selector": ["render", name],
                "value_type": "string",
            }
            for name in ["answer", "memory_receipt", "state", "model_used"]
        ],
    )
    nodes = [start, recall, rules, commit, narrate, render, end]
    edges = [
        {
            "id": f"{a['id']}-{b['id']}",
            "source": a["id"],
            "sourceHandle": "source",
            "target": b["id"],
            "targetHandle": "target",
            "type": "custom",
            "data": {
                "sourceType": a["data"]["type"],
                "targetType": b["data"]["type"],
                "isInIteration": False,
            },
        }
        for a, b in zip(nodes, nodes[1:])
    ]
    return {
        "version": "0.4.0",
        "kind": "app",
        "dependencies": [],
        "app": {
            "name": "昨日便利店",
            "description": "货架每天复原，店主却记得你。借伞、守约、回到昨天，试着打开通往明日的门。",
            "mode": "workflow",
            "icon": "🏪",
            "icon_background": "#FFF4DE",
            "use_icon_as_answer_icon": False,
        },
        "workflow": {
            "graph": {
                "nodes": nodes,
                "edges": edges,
                "viewport": {"x": 0, "y": 0, "zoom": 0.7},
            },
            "environment_variables": [
                {
                    "id": "store-url",
                    "name": "STORE_URL",
                    "value": "http://host.docker.internal:8010",
                    "value_type": "string",
                    "selector": ["env", "STORE_URL"],
                    "description": "Dify 可访问的记忆网关地址",
                },
                {
                    "id": "store-token",
                    "name": "STORE_TOKEN",
                    "value": "",
                    "value_type": "secret",
                    "selector": ["env", "STORE_TOKEN"],
                    "description": "在导入后填写本地随机密钥",
                },
            ],
            "conversation_variables": [],
            "features": {
                "file_upload": {"enabled": False},
                "opening_statement": "",
                "retriever_resource": {"enabled": False},
                "sensitive_word_avoidance": {"enabled": False},
                "speech_to_text": {"enabled": False},
                "suggested_questions": [],
                "suggested_questions_after_answer": {"enabled": False},
                "text_to_speech": {"enabled": False},
            },
        },
    }


if __name__ == "__main__":
    (ROOT / "yesterday-store.yml").write_text(
        yaml.safe_dump(build(), allow_unicode=True, sort_keys=False), encoding="utf-8"
    )
