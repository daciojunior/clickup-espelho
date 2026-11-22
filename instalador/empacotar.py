# Gera instalador-clinical-frontier.zip marcando o instalador do Mac como executável
# (o zip comum do Windows perde essa marca, e aí o duplo clique não funciona no Mac).
# Uso: python instalador/empacotar.py
import json, os, zipfile

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(os.path.dirname(here), "instalador-clinical-frontier.zip")
skip = {"empacotar.py", "Clickup.env", "config.exemplo.json"}  # o token nunca entra no pacote

# o pacote sempre leva a versão recém-compilada do ClickUp Espelho
import shutil
root = os.path.dirname(here)
os.makedirs(os.path.join(here, "plugins", "clickup-espelho"), exist_ok=True)
for f in ("main.js", "manifest.json", "styles.css"):
    shutil.copyfile(os.path.join(root, f), os.path.join(here, "plugins", "clickup-espelho", f))

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(here):
        for f in sorted(files):
            if f in skip:
                continue
            full = os.path.join(root, f)
            info = zipfile.ZipInfo.from_file(full, os.path.relpath(full, here).replace(os.sep, "/"))
            info.create_system = 3  # Unix, para o Mac respeitar as permissões
            info.external_attr = (0o100755 if f.endswith(".command") else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(full, "rb") as src:
                data = src.read()
            if f == "config.json":  # dados desta máquina e IDs do ClickUp não vão no pacote
                cfg = json.loads(data.decode("utf-8"))
                cfg.pop("devVault", None)
                spaces = cfg.pop("spaces", [])  # sem IDs no pacote: o instalador acha o space pelo nome
                if spaces:
                    cfg["spaceName"] = spaces[0]["name"]
                data = (json.dumps(cfg, ensure_ascii=False, indent=2) + chr(10)).encode("utf-8")
            z.writestr(info, data)
print("ok:", out)
