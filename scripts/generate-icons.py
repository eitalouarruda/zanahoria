"""Regenerate desktop and mobile icons with the project's installed Tauri CLI."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / "icon-src.svg").read_text()
with tempfile.TemporaryDirectory() as directory:
    temp = Path(directory)
    (temp / "icon.svg").write_text(source)
    # Android supplies its own full-bleed background behind the carrot.
    foreground = source.replace('<rect x="32" y="32" width="960" height="960" rx="220" fill="url(#background)"/>', '')
    (temp / "foreground.svg").write_text(foreground)
    (temp / "icons.json").write_text('''{
      "default": "icon.svg",
      "bg_color": "#18352e",
      "android_fg": "foreground.svg",
      "android_fg_scale": 85
    }''')
    subprocess.run([str(root / "node_modules/.bin/tauri"), "icon", str(temp / "icons.json"), "--output", str(temp / "generated")], cwd=root, check=True)
    shutil.copytree(temp / "generated", root / "src-tauri/icons", dirs_exist_ok=True)
    subprocess.run([str(root / "node_modules/.bin/tauri"), "icon", str(temp / "icon.svg"), "--output", str(temp / "source"), "--png", "1024"], cwd=root, check=True)
    shutil.copyfile(temp / "source/1024x1024.png", root / "icon-src.png")

android = root / "src-tauri/gen/android/app/src/main/res"
if android.exists():
    shutil.copytree(root / "src-tauri/icons/android", android, dirs_exist_ok=True)
