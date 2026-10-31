#!/usr/bin/env python3
"""Start an app from templates/mynt-app and wire in this build's generated SDKs.

usage: python3 scripts/scaffold_app.py <dest> [--mobile expo|kotlin|swift|flutter] [--no-web] [--no-mobile]
"""
import argparse, json, os, shutil, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(HERE, "templates", "mynt-app")
SDK = os.path.join(HERE, "job", "sdk")


def rename_package(path, name):
    with open(path) as f:
        pkg = json.load(f)
    pkg["name"] = name
    with open(path, "w") as f:
        json.dump(pkg, f, indent=2)
        f.write("\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dest")
    ap.add_argument("--mobile", default="expo", choices=["expo", "kotlin", "swift", "flutter"])
    ap.add_argument("--no-web", action="store_true")
    ap.add_argument("--no-mobile", action="store_true")
    a = ap.parse_args()

    if os.path.exists(a.dest) and os.listdir(a.dest):
        sys.exit(f"{a.dest} isn't empty")
    shutil.copytree(TEMPLATE, a.dest, dirs_exist_ok=True)
    packages = os.path.join(a.dest, "packages")

    # The TypeScript SDK (server client + ./browser) serves api/ and web/.
    shutil.copytree(os.path.join(SDK, "typescript"), os.path.join(packages, "mynt-sdk"))
    rename_package(os.path.join(packages, "mynt-sdk", "package.json"), "mynt-sdk")
    shutil.copy(os.path.join(SDK, "openapi.json"), os.path.join(packages, "openapi.json"))

    if a.no_web:
        shutil.rmtree(os.path.join(a.dest, "web"))
    if a.no_mobile:
        shutil.rmtree(os.path.join(a.dest, "mobile"))
    elif a.mobile == "expo":
        shutil.copytree(os.path.join(SDK, "react-native"), os.path.join(packages, "mynt-sdk-react-native"))
        rename_package(os.path.join(packages, "mynt-sdk-react-native", "package.json"), "mynt-sdk-react-native")
    else:
        # Native apps build outside Compose; the SDK sits next to them and the Expo skeleton goes.
        shutil.rmtree(os.path.join(a.dest, "mobile"))
        shutil.copytree(os.path.join(SDK, a.mobile), os.path.join(a.dest, "mobile", "mynt-sdk"))

    # Keep the root workspaces list to the parts that exist.
    root = os.path.join(a.dest, "package.json")
    with open(root) as f:
        pkg = json.load(f)
    pkg["workspaces"] = [w for w in pkg["workspaces"] if w == "packages/*" or os.path.exists(os.path.join(a.dest, w, "package.json"))]
    with open(root, "w") as f:
        json.dump(pkg, f, indent=2)
        f.write("\n")
    print(f"scaffolded {a.dest}: workspaces {', '.join(pkg['workspaces'])}")


if __name__ == "__main__":
    main()
