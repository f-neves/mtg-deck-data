"""Le uma pagina de carta da LigaMagic salva (HTML ou HAR) e extrai os precos por impressao.

Nao faz nenhuma requisicao a LigaMagic. A entrada e um arquivo que o proprio usuario salvou no
navegador (Ctrl+S na pagina da carta, ou HAR exportado do DevTools). Opcionalmente consulta o
Scryfall para casar cada impressao da Liga com um scryfall_id.

Uso:
    python liga_parse.py download                  # HAR
    python liga_parse.py pagina.html --scryfall    # HTML + casamento com Scryfall
"""
import argparse
import base64
import html as htmllib
import json
import re
import sys
import time
import urllib.parse
import urllib.request

# Ids de "extras" da Liga (vem em dataExtras na propria pagina). 0 = normal.
FINISH = {0: "nonfoil", 2: "foil", 31: "etched"}

# Codigos antigos/proprios da Liga -> codigo do Scryfall. Cresce sob demanda.
SET_TABLE = {
    "7e": "7ed", "6e": "6ed", "5e": "5ed", "4e": "4ed", "4eb": "4bb", "mm": "mmq", "tp": "tmp",
    "ia": "ice", "rv": "3ed", "rvb": "fbb", "rvw": "fwb", "un": "2ed", "be": "leb", "al": "lea",
    "st": "s99", "bd": "btd", "br": "brb", "cedi": "cei", "ced": "ced", "summer": "sum",
    "ddajvc": "dd2", "mpsakh": "mp2", "slc79": "slc", "slp01": "slp",
}
# Prefixos que a Liga usa para separar variantes de uma mesma colecao do Scryfall.
PREFIXES = ["cb", "bl", "rf", "jp", "js", "sh", "fs", "ii", "ds", "ex", "mf", "as", "tk", "pr",
            "sp", "ls", "rr", "b", "p", "v", "c", "e", "s"]


def load_html(path):
    raw = open(path, encoding="utf-8").read()
    if raw.lstrip().startswith("{"):
        har = json.loads(raw)
        for e in har["log"]["entries"]:
            c = e["response"]["content"]
            if "cards_editions" in (c.get("text") or "") or c.get("encoding") == "base64":
                t = c.get("text") or ""
                if c.get("encoding") == "base64":
                    t = base64.b64decode(t).decode("utf-8", "replace")
                if "cards_editions" in t:
                    return t
        sys.exit("HAR sem pagina de carta (cards_editions)")
    return raw


def grab(src, name):
    m = re.search(r"var\s+%s\s*=\s*" % name, src)
    if not m:
        return None
    return json.JSONDecoder().raw_decode(src[m.end():])[0]


def num(v):
    try:
        f = float(v)
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


def parse(src):
    eds = grab(src, "cards_editions") or []
    param = grab(src, "param") or {}
    out = []
    for e in eds:
        price = e.get("price")
        if isinstance(price, list):  # lista = so normal
            price = {"0": price[0]} if price else {}
        finishes = {}
        for k, v in (price or {}).items():
            if not v:
                continue  # [] = sem oferta
            fin = FINISH.get(int(k), "extra:%s" % k)
            finishes[fin] = {"min": num(v.get("p")), "avg": num(v.get("m")), "max": num(v.get("g"))}
        out.append({
            "liga_card_id": e.get("idcard"),
            "liga_edition_id": e.get("id"),
            "liga_code": e.get("code"),
            "collector_number": e.get("num"),
            "edition_name": htmllib.unescape(e.get("name") or ""),
            "release": (e.get("date") or "")[:10],
            "not_tournament_legal": bool(e.get("ntl")),
            "prices_brl": finishes,
        })
    return {"liga_card_id": (param.get("card") or {}).get("id"), "printings": out}


def scryfall_prints(name):
    q = urllib.parse.quote('!"%s" include:extras' % name)
    url = "https://api.scryfall.com/cards/search?q=%s&unique=prints" % q
    cards = []
    while url:
        req = urllib.request.Request(url, headers={"User-Agent": "grimorio-liga-parse/0.1", "Accept": "application/json"})
        d = json.load(urllib.request.urlopen(req))
        cards += d["data"]
        url = d.get("next_page")
        time.sleep(0.1)
    return cards


def candidate_sets(code):
    if code in SET_TABLE:
        return [SET_TABLE[code]]
    if re.fullmatch(r"sld(?:ex)?\d+(jp)?", code):
        return ["sld"]
    m = re.fullmatch(r"mfpf(\d\d)", code)
    if m:
        return ["pf" + m.group(1)]
    c = [code]
    for p in PREFIXES:
        if code.startswith(p) and len(code) > len(p) + 1:
            c.append(code[len(p):])
    return c


def match(printing, cards):
    code, n = printing["liga_code"], printing["collector_number"]
    hit = [c for c in cards if c["set"] == code and c["collector_number"] == n]
    if len(hit) == 1:
        return hit[0], "exato"
    sets = candidate_sets(code)
    hit = [c for c in cards if c["set"] in sets and c["collector_number"] == n]
    if len(hit) == 1:
        return hit[0], "regra+numero"
    hit = [c for c in cards if c["set"] in sets]
    if len(hit) == 1:
        return hit[0], "colecao unica"
    return None, "nao resolvido"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("arquivo")
    ap.add_argument("--scryfall", action="store_true", help="casa cada impressao com um scryfall_id")
    a = ap.parse_args()
    src = load_html(a.arquivo)
    data = parse(src)
    if a.scryfall:
        title = re.search(r"<title>([^<|]+)", src)
        en = htmllib.unescape(title.group(1)).split("/")[-1].strip() if title else ""
        cards = scryfall_prints(en)
        stats = {}
        for p in data["printings"]:
            c, how = match(p, cards)
            p["scryfall_id"] = c["id"] if c else None
            p["match"] = how
            stats[how] = stats.get(how, 0) + 1
        data["match_stats"] = stats
    sys.stdout.reconfigure(encoding="utf-8")
    json.dump(data, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
