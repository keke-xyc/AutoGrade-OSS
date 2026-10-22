"""Local administrator setup and private-data backups."""
import argparse
import getpass
import os
import sqlite3
import tempfile
import zipfile
from contextlib import closing
from datetime import datetime
from pathlib import Path

import app


def setup(username="admin"):
    username = username.strip().lower()
    password = getpass.getpass("设置账号密码（至少10个字符）：")
    if not 10 <= len(password) <= 256:
        raise SystemExit("密码长度需为10—256个字符")
    if getpass.getpass("再次输入密码：") != password:
        raise SystemExit("两次密码不一致")
    value = app.UserInput(username=username, display_name=username, password=password)
    env = app.ROOT / ".env"
    if not env.exists():
        env.write_text((app.ROOT / ".env.example").read_text(encoding="utf-8"), encoding="utf-8")
    app.init_db()
    encoded = app.hash_password(value.password)
    with app.db() as c:
        c.execute("BEGIN IMMEDIATE")
        user = c.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
        if user:
            c.execute("UPDATE users SET password_hash=?,enabled=1,must_change_password=0 WHERE id=?", (encoded, user["id"]))
            c.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
        else:
            first = not c.execute("SELECT 1 FROM users").fetchone()
            c.execute("INSERT INTO users(id,username,display_name,password_hash,is_admin,must_change_password,created) VALUES(?,?,?,?,?,?,?)",
                      (app.uuid.uuid4().hex, username, username, encoded, int(first), int(not first), app.time.time()))
    print(f"账号 {username} 已设置，密码保存在数据库；旧登录已失效。首个账号为管理员，新老师首次登录需改密码。")


def upgrade():
    """Offline upgrade: retain the old data as a private rollback directory."""
    if app.DB.exists():
        with closing(sqlite3.connect(app.DB)) as c:
            if c.execute("SELECT 1 FROM sqlite_master WHERE name='users'").fetchone():
                raise SystemExit("已是多用户数据库，无需重建")
        archive = app.DATA / f"before-multiuser-{datetime.now():%Y%m%d-%H%M%S}"
        archive.mkdir(mode=0o700)
        for name in ("homework.sqlite3", "homework.sqlite3-wal", "homework.sqlite3-shm", "images"):
            source = app.DATA / name
            if source.exists():
                if source.resolve().parent != app.DATA or archive.resolve().parent != app.DATA:
                    raise SystemExit("拒绝移动数据目录以外的路径")
                source.rename(archive / name)
        print(f"旧数据已隔离到 {archive}；新工作台不再显示旧数据。")
    app.init_db()
    print("多用户数据库已建立。原配置密码首次导入为 admin；未配置时请运行 manage.py setup。")


def backup(output):
    if not app.DB.exists():
        raise SystemExit("尚无数据库可备份")
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise SystemExit("目标备份文件已存在，拒绝覆盖")
    with tempfile.TemporaryDirectory() as temp:
        snapshot = Path(temp) / "homework.sqlite3"
        with closing(sqlite3.connect(app.DB)) as source, closing(sqlite3.connect(snapshot)) as target:
            source.backup(target)
            target.execute("DELETE FROM sessions")
            target.commit()
        with closing(sqlite3.connect(snapshot)) as c:
            files = {value for row in c.execute("SELECT original,full,thumb FROM photos") for value in row}
            if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='materials'").fetchone():
                files.update(value for row in c.execute("SELECT original,full,thumb FROM materials") for value in row)
        partial = output.with_suffix(output.suffix + ".partial")
        with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(snapshot, "homework.sqlite3")
            for relative in sorted(files):
                path = (app.DATA / relative).resolve()
                if not path.is_relative_to(app.DATA) or not path.is_file():
                    raise SystemExit("备份中断：有照片缺失。请停止服务后再备份。")
                archive.write(path, path.relative_to(app.DATA).as_posix())
        os.replace(partial, output)
    print(f"备份完成：{output}\n备份包含账号及密码哈希、用量、学生、作业和照片，不包含 .env 密钥。请妥善保管。")


def restore(source):
    if any(app.DATA.iterdir()):
        raise SystemExit("数据目录非空，拒绝覆盖。请停止服务，保留旧数据并设置新的 DATA_DIR 后恢复。")
    with zipfile.ZipFile(source) as archive:
        names = archive.namelist()
        if "homework.sqlite3" not in names:
            raise SystemExit("无效备份：缺少数据库")
        for name in names:
            destination = (app.DATA / name).resolve()
            if not destination.is_relative_to(app.DATA) or "\\" in name or ":" in name:
                raise SystemExit("无效备份路径")
        archive.extractall(app.DATA)
    with app.db() as c:
        if c.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit("数据库完整性校验失败")
        if not c.execute("SELECT 1 FROM sqlite_master WHERE name='users'").fetchone():
            raise SystemExit("这是单用户旧备份，不能直接用于多用户版本；请保留原备份并运行 manage.py upgrade 建立新库")
        if c.execute("PRAGMA foreign_key_check").fetchone():
            raise SystemExit("数据库关联完整性校验失败")
        c.execute("DELETE FROM sessions")
        rows = list(c.execute("SELECT original,full,thumb FROM photos"))
        if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='materials'").fetchone():
            rows += list(c.execute("SELECT original,full,thumb FROM materials"))
        for row in rows:
            if any(not (app.DATA / path).resolve().is_relative_to(app.DATA) or not (app.DATA / path).is_file() for path in row):
                raise SystemExit("恢复后照片完整性校验失败")
    print("恢复完成，所有旧登录已撤销。账号密码随数据库恢复，请检查 .env 的 API 密钥后启动服务。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="作业小笺本机管理")
    sub = parser.add_subparsers(dest="command", required=True)
    setup_parser = sub.add_parser("setup", help="创建账号或重置其密码；首个账号为管理员")
    setup_parser.add_argument("--username", default="admin")
    sub.add_parser("upgrade", help="停止服务后隔离旧版数据并建立多用户库")
    b = sub.add_parser("backup", help="停止服务后备份数据库与图片")
    b.add_argument("output", nargs="?", default=f"backups/homework-{datetime.now():%Y%m%d-%H%M%S}.zip")
    r = sub.add_parser("restore", help="恢复到空的数据目录")
    r.add_argument("source")
    args = parser.parse_args()
    {"setup": lambda: setup(args.username), "upgrade": upgrade, "backup": lambda: backup(args.output), "restore": lambda: restore(args.source)}[args.command]()
