#!/usr/bin/env python3
"""Confirm public theme credits and add source-specific attribution headers."""

import argparse
import io
import json
import os
import re
import sys
import tokenize
from pathlib import Path


EXTENSIONS = {".java", ".js", ".jsx", ".ts", ".tsx", ".html", ".htm", ".py"}
IGNORED = {".git", "node_modules", "dist", "build", "coverage", "__pycache__", "assets"}
LABELS = ("Project", "Author", "Course")
MARKER = "Theme Credits (generated)"
END = "End Theme Credits"
FIELD = re.compile(r"^\s*(?://|#|\*)?\s*(Project|Author|Course|Description):\s*(.*?)\s*$", re.I)
ENCODING = re.compile(r"^[ \t\f]*#.*?coding[:=][ \t]*[-\w.]+")


def source_files(root):
    paths = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in IGNORED and not d.startswith(".")
                         and not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            if path.suffix.lower() in EXTENSIONS:
                if path.is_symlink():
                    raise ValueError(f"Refusing source symlink: {path}")
                paths.append(path)
    return sorted(paths, key=lambda p: p.relative_to(root).as_posix())


def read_source(path):
    data = path.read_bytes()
    if path.suffix.lower() == ".py":
        encoding, _ = tokenize.detect_encoding(io.BytesIO(data).readline)
    else:
        encoding = "utf-8-sig" if data.startswith(b"\xef\xbb\xbf") else "utf-8"
    return data.decode(encoding), encoding


def preamble_length(text, suffix):
    lines = text.splitlines(keepends=True)
    count = 0
    if lines and lines[0].startswith("#!") and suffix in {".py", ".js", ".jsx", ".ts", ".tsx"}:
        count = 1
    if suffix == ".py":
        for i in range(min(2, len(lines))):
            if ENCODING.match(lines[i]):
                count = max(count, i + 1)
    return sum(len(line) for line in lines[:count])


def leading_comments(text, suffix):
    text = text[preamble_length(text, suffix):]
    chunks = []
    while True:
        text = text.lstrip()
        if text.startswith("/*") and suffix in {".java", ".js", ".jsx", ".ts", ".tsx"}:
            end = text.find("*/", 2)
            if end < 0:
                break
            chunks.append(text[2:end])
            text = text[end + 2:]
        elif text.startswith("<!--") and suffix in {".html", ".htm"}:
            end = text.find("-->", 4)
            if end < 0:
                break
            chunks.append(text[4:end])
            text = text[end + 3:]
        elif (text.startswith("//") and suffix in {".java", ".js", ".jsx", ".ts", ".tsx"}
              or text.startswith("#") and suffix == ".py"):
            line, _, text = text.partition("\n")
            chunks.append(line)
        else:
            break
    values = {}
    for line in "\n".join(chunks).splitlines():
        match = FIELD.match(line)
        if match and match.group(2).strip():
            values.setdefault(match.group(1).capitalize(), []).append(match.group(2).strip())
    return values


def prompt_value(label, suggestions, required):
    print(f"\n{label} suggestions:")
    for number, (value, origins) in enumerate(suggestions.items(), 1):
        print(f"  {number}. {value} ({', '.join(origins)})")
    while True:
        if len(suggestions) == 1:
            answer = input(f"{label} [Enter to use suggestion, or type a value"
                           + (", '-' to omit" if not required else "") + "]: ").strip()
            if not answer:
                return next(iter(suggestions))
        elif len(suggestions) > 1:
            answer = input(f"{label} [choose a number or type a value"
                           + (", '-' to omit" if not required else "") + "]: ").strip()
            if answer.isdigit():
                index = int(answer) - 1
                if 0 <= index < len(suggestions):
                    return list(suggestions)[index]
                print("Choose a listed number or enter a value.")
                continue
        else:
            answer = input(f"{label}" + (" (optional, Enter to omit)" if not required else " (required)") + ": ").strip()
        if not required and (not answer or answer == "-"):
            return ""
        if answer:
            return answer
        print(f"{label} requires an explicit nonblank value or choice.")


def generated_region(text, suffix):
    start = preamble_length(text, suffix)
    rest = text[start:]
    if suffix == ".py":
        pattern = r"\# Theme Credits \(generated\)\r?\n(?:\# [^\r\n]*\r?\n)*\# End Theme Credits\r?\n"
    elif suffix in {".html", ".htm"}:
        pattern = r"<!-- Theme Credits \(generated\)\r?\n.*?\r?\nEnd Theme Credits -->\r?\n"
    else:
        pattern = r"/\* Theme Credits \(generated\)\r?\n.*?\r?\n \* End Theme Credits\r?\n \*/\r?\n"
    match = re.match(pattern, rest, re.DOTALL)
    if MARKER in rest and not match:
        raise ValueError("Existing generated header is misplaced or malformed; no files were changed.")
    if match and MARKER in rest[match.end():]:
        raise ValueError("Multiple generated headers found; no files were changed.")
    return start, start + (match.end() if match else 0)


def make_header(suffix, credits, description, newline):
    values = [credits["Project"], credits["Author"], description, credits["Course"]]
    if any("*/" in value or "-->" in value or "\r" in value or "\n" in value for value in values):
        raise ValueError("A credit or description contains a comment terminator or newline.")
    fields = [f"Project: {credits['Project']}", f"Author: {credits['Author']}",
              f"Description: {description}"]
    if credits["Course"]:
        fields.append(f"Course: {credits['Course']}")
    if suffix == ".py":
        lines = [f"# {MARKER}"] + [f"# {line}" for line in fields] + [f"# {END}"]
    elif suffix in {".html", ".htm"}:
        if any("--" in value for value in values):
            raise ValueError("HTML comment values cannot contain '--' or a comment terminator.")
        lines = [f"<!-- {MARKER}"] + fields + [f"{END} -->"]
    else:
        lines = [f"/* {MARKER}"] + [f" * {line}" for line in fields] + [f" * {END}", " */"]
    return newline.join(lines) + newline


def setup(root):
    manifest_path = root / "theme.json"
    if not root.is_dir() or not manifest_path.is_file() or manifest_path.is_symlink():
        raise ValueError("An existing theme directory with a non-symlink theme.json is required.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if not isinstance(manifest, dict):
        raise ValueError("theme.json must contain a JSON object.")

    sources = []
    suggestions = {label: {} for label in LABELS}
    for label in LABELS:
        keys = (label.lower(), "name") if label == "Project" else (label.lower(),)
        for key in keys:
            value = manifest.get(key)
            if isinstance(value, str) and value.strip():
                suggestions[label].setdefault(value.strip(), []).append(f"theme.json ({key})")
    for path in source_files(root):
        text, encoding = read_source(path)
        values = leading_comments(text, path.suffix.lower())
        for label in LABELS:
            for value in values.get(label, []):
                origins = suggestions[label].setdefault(value, [])
                origin = path.relative_to(root).as_posix()
                if origin not in origins:
                    origins.append(origin)
        sources.append((path, text, encoding, values))

    credits = {label: prompt_value(label, suggestions[label], label != "Course") for label in LABELS}
    updates = []
    for path, text, encoding, values in sources:
        name = path.relative_to(root).as_posix()
        start, end = generated_region(text, path.suffix.lower())
        generated = leading_comments(text[start:end], path.suffix.lower()) if end > start else {}
        previous = generated.get("Description", []) or values.get("Description", [])
        default = previous[0] if previous else f"Source file: {name}"
        description = input(f"Description for {name} [{default}]: ").strip() or default
        newline = "\r\n" if "\r\n" in text else "\n"
        header = make_header(path.suffix.lower(), credits, description, newline)
        if start and not text[:start].endswith(("\n", "\r")):
            raise ValueError(f"Preamble has no terminating newline: {name}")
        updates.append((path, (text[:start] + header + text[end:]).encode(encoding)))
    print("\nPublic credits to write:")
    for label in LABELS:
        print(f"  {label}: {credits[label] or '(omitted)'}")
    if input("Confirm credits and source headers? [y/N]: ").strip().lower() not in {"y", "yes"}:
        raise ValueError("Cancelled; no files were changed.")
    for label in LABELS:
        if credits[label]:
            manifest[label.lower()] = credits[label]
        else:
            manifest.pop(label.lower(), None)
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    for path, data in updates:
        path.write_bytes(data)
    manifest_path.write_bytes(manifest_bytes)
    print(f"Updated {manifest_path} and {len(updates)} source file(s).")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("theme_directory", type=Path)
    args = parser.parse_args()
    try:
        setup(args.theme_directory.resolve())
    except EOFError:
        print("Credit setup failed: input ended before confirmation; no files were changed.", file=sys.stderr)
        return 1
    except (ValueError, OSError, UnicodeError, SyntaxError) as error:
        print(f"Credit setup failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
