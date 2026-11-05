#!/usr/bin/env python3
"""Dump validate_batch flags as JSON（給 schema 對照測試用）。stdout = JSON。"""
import base64, json, pathlib, re, sys
import jsonschema

HERE = pathlib.Path(__file__).resolve().parent
SCHEMA = json.loads((HERE.parent / "schema.json").read_text())
FIG_WORDS = re.compile(r"如圖|下圖|右圖|左圖|上圖|附圖|圖[（(一二三四五六七八九十0-9]|如表|下表|右表|附表")

def collect(d):
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
            f.add("EXPLAIN_MISMATCH")
        if not q["explain"].strip(): f.add("EXPLAIN_MISSING")
        if q["extract"]["confidence"] < 0.8: f.add("LOW_CONFIDENCE")
        if q["stem"].count("\\(") != q["stem"].count("\\)") or q["explain"].count("\\(") != q["explain"].count("\\)"):
            f.add("FORMULA_CHECK")
        g = groups.get(q["groupId"]) if q["groupId"] else None
        if q["groupId"] and (not g or q["id"] not in g["questionIds"]): f.add("GROUP_BROKEN")
        text = q["stem"] + (g["passage"] if g else "")
        has_fig = q["figures"] or (g and g["figures"])
        if FIG_WORDS.search(text) and not has_fig: f.add("FIGURE_MISSING")
        for fig in (q["figures"] or []) + ((g["figures"] if g else []) or []):
            raw = fig["src"].split(",", 1)[1]
            try: size = len(base64.b64decode(raw, validate=False))
            except Exception: size = 0
            if size > 150 * 1024: f.add("IMAGE_TOO_BIG")
            if size < 200: f.add("FIGURE_MISSING")
        f.update(q["review"]["flags"])
    for gid, g in groups.items():
        for qid in g["questionIds"]:
            if qid not in flags: batch_flags.append(f"GROUP_BROKEN：{gid} 指到不存在的 {qid}")
    return {
        "batchFlags": batch_flags,
        "flags": {k: sorted(v) for k, v in flags.items()},
        "exitCode": 1 if (any(flags[q["id"]] for q in qs) or batch_flags) else 0,
    }

def main():
    path = pathlib.Path(sys.argv[1])
    d = json.loads(path.read_text())
    errs = list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(d))
    if errs:
        print(json.dumps({"exitCode": 2, "schemaErrors": [e.message for e in errs[:20]]}, ensure_ascii=False))
        return
    print(json.dumps(collect(d), ensure_ascii=False))

if __name__ == "__main__":
    main()
