"""昨日便利店的规则；由 Dify Code 节点执行，不调用模型或数据库。"""

import json


def initial_state():
    return {
        "day": 1,
        "trust": 0,
        "debt": False,
        "umbrella": False,
        "bell": False,
        "escaped": False,
    }


def main(snapshot: str, action: str, request_id: str) -> dict:
    loaded = json.loads(snapshot)
    state = dict(loaded.get("state") or initial_state())
    before = dict(state)
    action = action.strip()
    allowed = ["观察", "借伞", "还伞", "偷铃", "道歉", "回到昨天", "敲铃"]
    if action not in allowed:
        raise ValueError("请选择：" + "、".join(allowed))
    if state["escaped"]:
        story = "门外已经是明天。店主把营业牌翻过来：有些承诺，连时间都不能退货。你已通关；换一个玩家编号可开始新故事。"
    elif action == "观察":
        story = "货架上只有一把雨伞、一只铃铛和一张写着‘昨日’的收据。门外永远下雨。店主说：借的东西要还，偷的东西会记账。"
        if state["day"] > 1 and state["debt"]:
            story += " 他忽然按住铃铛：昨天的账，我可没忘。"
        elif state["day"] > 1 and state["trust"]:
            story += " 他把铃铛推向你：昨天还伞的人，今天可以试试这个。"
    elif action == "借伞":
        if state["debt"]:
            story = "店主把伞收回柜台：昨天偷走的铃铛还记在账上。先说清楚，再谈借。"
        elif state["umbrella"]:
            story = "你已经借了一把伞。便利店没有第二个昨天可供你打包。"
        else:
            state["umbrella"] = True
            story = "你借走雨伞。雨落在伞面上，声音像倒着走的秒针。店主在收据上写下：待归还。"
    elif action == "还伞":
        if state["umbrella"]:
            state["umbrella"] = False
            state["trust"] = min(3, state["trust"] + 1)
            story = "你把雨伞还给店主。他擦掉收据上的欠条：即使明天变回昨天，我也会记得你守过约。"
        else:
            story = "你两手空空。店主笑了：不能把一句‘我还过了’当雨伞归还。"
    elif action == "偷铃":
        state["bell"] = True
        state["debt"] = True
        state["trust"] = 0
        story = "铃铛进了你的口袋，整家店突然安静。店主没有拦你，只在看不见的账本上记了一笔。"
    elif action == "道歉":
        if state["debt"]:
            state["debt"] = False
            state["bell"] = False
            story = "你承认偷铃。店主合上账本：记得错误，是为了给改正留个位置。欠账清了，信任要重新积攒。"
        else:
            story = "店主递来一张空白收据：你没有欠账，不必替一个还没发生的错误道歉。"
    elif action == "回到昨天":
        if state["umbrella"]:
            state["debt"] = True
            state["trust"] = 0
        state["day"] += 1
        state["umbrella"] = False
        state["bell"] = False
        story = "你撕掉收据。货架和雨声恢复原样，口袋也空了。"
        story += (
            "店主却说：昨天没结清的账，还在。"
            if state["debt"]
            else "店主却认出了你：时间能重来，守约不会白费。"
            if state["trust"]
            else "店主看了看你：又见面了。"
        )
    else:
        if state["debt"]:
            story = "铃响了一半就停住了。门后传来一句话：先结昨天的账。"
        elif state["day"] < 2:
            story = "铃声把雨震停了一秒。店主提醒：先留下一个值得我记住的昨天，再回来。"
        elif state["trust"] < 1:
            story = "铃铛没有声音。店主说：门只为守过约、而且敢回头的人打开。"
        else:
            state["escaped"] = True
            story = "铃声终于向前走了。店主认出了昨天还伞的你，把门牌翻成‘明日’。你带走的不是雨伞，是一次没有被时间抹掉的信任。【通关：守约的人】"
    if state["escaped"]:
        choices = []
    elif state["debt"]:
        choices = ["观察", "道歉", "回到昨天", "敲铃"]
    else:
        choices = [
            "观察",
            "还伞" if state["umbrella"] else "借伞",
            "回到昨天",
            "敲铃",
            "偷铃",
        ]
    result = {
        "request_id": request_id,
        "expected_revision": loaded["revision"],
        "action": action,
        "state": state,
        "story": story,
        "choices": choices,
        "memory_effect": {
            key: {"before": before[key], "after": state[key]}
            for key in state
            if state[key] != before[key]
        },
    }
    return {"transition": json.dumps(result, ensure_ascii=False), "story": story}
