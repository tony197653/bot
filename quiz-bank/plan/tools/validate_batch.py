#!/usr/bin/env python3
"""檢查一個匯入批次 JSON。跟匯入頁的紅標規則相同（規格書 §4.5）。
用法：python3 validate_batch.py batch.json [--fix]
--fix：把查到的紅標補進各題 review.flags，有紅標的題目 status 改成 flagged，另存成 *.checked.json。
回傳碼：0 無紅標、1 有紅標、2 格式錯誤（schema 不合）。
"""
import base64, json, pathlib, re, sys
import jsonschema

HERE = pathlib.Path(__file__).resolve().parent
SCHEMA = json.loads((HERE.parent / "schema.json").read_text())
FIG_WORDS = re.compile(r"如圖|下圖|右圖|左圖|上圖|附圖|圖[（(一二三四五六七八九十0-9]|如表|下表|右表|附表")

def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    path = pathlib.Path(sys.argv[1]); fix = "--fix" in sys.argv
    d = json.loads(path.read_text())
    errs = sorted(jsonschema.Draft202012Validator(SCHEMA).iter_errors(d), key=lambda e: list(e.path))
    if errs:
        print("格式錯誤（先修這些才能匯入）：")
        for e in errs[:30]: print("  -", "/".join(map(str, e.path)) or "(根)", "：", e.message[:160])
        sys.exit(2)

    qs, groups = d["questions"], {g["groupId"]: g for g in d["groups"]}
    flags = {q["id"]: set() for q in qs}
    batch_flags = []
    if len(qs) != d["batch"]["expectedCount"]:
        batch_flags.append(f"COUNT_MISMATCH：照片 {d['batch']['expectedCount']} 題，JSON {len(qs)} 題")
    seen = set()
    for q in qs:
        f, s = flags[q["id"]], q["source"]
        if q["id"] in seen: f.add("DUPLICATE_ID")
        seen.add(q["id"])
        want_id = f"{s['bookId']}-{q['unitCode'].lower()}-r{s['round']}-q{s['number']:02d}"
        want_key = f"{q['unitCode']}|{s['round']}|{s['number']}"
        if q["id"] != want_id or s["matchKey"] != want_key or s["bookId"] != d["book"]["bookId"]:
            f.add("EXPLAIN_MISMATCH"); print(f"  {q['id']}：id／matchKey 跟來源對不上，應為 {want_id}／{want_key}")
        if not q["explain"].strip(): f.add("EXPLAIN_MISSING")
        if q["extract"]["confidence"] < 0.8: f.add("LOW_CONFIDENCE")
        if q["stem"].count("\\(") != q["stem"].count("\\)") or q["explain"].count("\\(") != q["explain"].count("\\)"):
            f.add("FORMULA_CHECK")
        g = groups.get(q["groupId"]) if q["groupId"] else None
        if q["groupId"] and (not g or q["id"] not in g["questionIds"]): f.add("GROUP_BROKEN")
        text = q["stem"] + (g["passage"] if g else "")
        has_fig = q["figures"] or (g and g["figures"])
        if FIG_WORDS.search(text) and not has_fig: f.add("FIGURE_MISSING")
        for fig in q["figures"] + (g["figures"] if g else []):
            raw = fig["src"].split(",", 1)[1]
            try: size = len(base64.b64decode(raw, validate=False))
            except Exception: size = 0
            if size > 150 * 1024: f.add("IMAGE_TOO_BIG")
            if size < 200: f.add("FIGURE_MISSING")
        f.update(q["review"]["flags"])
    for gid, g in groups.items():
        for qid in g["questionIds"]:
            if qid not in flags: batch_flags.append(f"GROUP_BROKEN：{gid} 指到不存在的 {qid}")

    total = 0
    for b in batch_flags: print("整批紅標：", b)
    for q in qs:
        f = sorted(flags[q["id"]])
        if f: total += 1; print(f"第 {q['source']['number']} 題 {q['id']}：{'、'.join(f)}")
        for u in q["extract"]["uncertain"]: print(f"    待確認：{u}")
    print(f"共 {len(qs)} 題，{total} 題有紅標" + ("，另有整批紅標" if batch_flags else ""))
    if fix:
        for q in qs:
            q["review"]["flags"] = sorted(flags[q["id"]] | ({"COUNT_MISMATCH"} if batch_flags and any(b.startswith("COUNT") for b in batch_flags) else set()))
            if q["review"]["flags"] and q["review"]["status"] == "draft": q["review"]["status"] = "flagged"
        out = path.with_suffix(".checked.json"); out.write_text(json.dumps(d, ensure_ascii=False, indent=1))
        print("已另存：", out)
    sys.exit(1 if (total or batch_flags) else 0)

main()
