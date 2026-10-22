"""Account boundaries and offline upgrade checks; never call a real model."""
import asyncio
import io
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
import uuid
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
import manage
from fastapi.testclient import TestClient
from PIL import Image

PASSWORD = "multiuser-test-password"
NEW_PASSWORD = "changed-test-password"
HASH = app.hash_password(PASSWORD)
REAL_WORKER = app.worker
RESULT = {"questions": [{"page": 1, "number": "1", "question": "2+3", "student_answer": "5", "status": "correct", "expected_answer": "5", "explanation": "正确", "knowledge_point": "加法"}], "observations": [], "warnings": []}


async def idle_worker():
    await asyncio.Event().wait()


class MultiUserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for target, value in (("DATA", Path(self.temp.name)), ("DB", Path(self.temp.name) / "homework.sqlite3"), ("worker", idle_worker)):
            patcher = patch.object(app, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        env = patch.dict(os.environ, ADMIN_PASSWORD_HASH=HASH, DEEPSEEK_API_KEY="offline-only", COOKIE_SECURE="false", PUBLIC_ORIGIN="")
        env.start()
        self.addCleanup(env.stop)
        app.login_attempts.clear()
        self.context = TestClient(app.app)
        self.admin = self.context.__enter__()
        self.addCleanup(self.context.__exit__, None, None, None)
        self.login(self.admin, "admin")
        self.admin_id = self.admin.get("/api/me").json()["user"]["user_id"]
        self.alice, self.alice_id = self.teacher("alice")
        self.bob, self.bob_id = self.teacher("bob")

    def login(self, client, username, password=PASSWORD):
        response = client.post("/api/login", json={"username": username, "password": password})
        self.assertEqual(response.status_code, 200, response.text)
        client.headers["X-CSRF-Token"] = response.json()["csrf"]

    def teacher(self, username):
        response = self.admin.post("/api/admin/users", json={"username": username, "display_name": username, "password": PASSWORD})
        self.assertEqual(response.status_code, 201, response.text)
        ident = response.json()["id"]
        client = TestClient(app.app)
        self.addCleanup(client.close)
        self.login(client, username)
        self.assertEqual(client.get("/api/students").status_code, 403)
        self.assertEqual(client.put("/api/account/password", json={"old_password": PASSWORD, "new_password": NEW_PASSWORD}).status_code, 200)
        self.login(client, username, NEW_PASSWORD)
        return client, ident

    def seed(self, client, owner_id, key=None, status="review"):
        student = client.post("/api/students", json={"name": "同名学生", "grade": "六年级"}).json()["id"]
        job, photo, material = [uuid.uuid4().hex for _ in range(3)]
        buffer = io.BytesIO()
        Image.new("RGB", (100, 180), "white").save(buffer, "JPEG")
        folder = app.DATA / "images" / job
        folder.mkdir(parents=True)
        paths = app.prepare_photo(buffer.getvalue(), folder, photo)
        with app.db() as c:
            c.execute("INSERT INTO jobs(id,submit_key,user_id,student_id,day,status,result,created,updated) VALUES(?,?,?,?,?,?,?,?,?)", (job, key or uuid.uuid4().hex, owner_id, student, "2026-10-15", status, json.dumps(RESULT), time.time(), time.time()))
            c.execute("INSERT INTO photos(id,job_id,page,name,original,full,thumb) VALUES(?,?,1,'private.jpg',?,?,?)", (photo, job, *paths))
            c.execute("INSERT INTO materials(id,job_id,page,file_index,source_page,name,original,full,thumb) VALUES(?,?,1,0,1,'private-original.jpg',?,?,?)", (material, job, *paths))
        return student, job, photo, material, buffer.getvalue()

    def test_all_job_routes_and_files_are_scoped_even_for_admin(self):
        student, job, photo, material, raw = self.seed(self.alice, self.alice_id, "alice-only")
        self.assertEqual(self.alice.get(f"/api/jobs/{job}").status_code, 200)
        bbox = {"x": 0, "y": 0, "width": .8, "height": .8}
        routes = [("GET", "", None), ("DELETE", "", None), ("PUT", "/review", {"revision": 0, "result": RESULT}), ("POST", "/feedback", {"revision": 0}), ("PUT", "/feedback", {"revision": 0, "feedback": "不应保存"}), ("POST", "/confirm", {"revision": 0}), ("POST", "/retry", {"revision": 0}), ("POST", "/judge-text", {"revision": 0, "question_index": 0}), ("POST", "/crop", {"revision": 0, "question_index": 0, "photo_id": photo, **bbox}), ("PUT", "/location", {"revision": 0, "question_index": 0, "photo_id": photo, "bbox": bbox}), ("POST", "/locate", {"revision": 0, "photo_id": photo})]
        with patch.object(app, "model_call") as model:
            for outsider in (self.bob, self.admin):
                self.assertEqual(outsider.get("/api/students").json(), [])
                listed = outsider.get("/api/jobs", params={"filter": "all", "student_id": student}).json()
                self.assertEqual(listed["total"], 0)
                self.assertTrue(all(n == 0 for n in listed["counts"].values()))
                self.assertEqual(outsider.get("/api/submissions/alice-only").json(), {"id": None})
                self.assertEqual(outsider.delete(f"/api/students/{student}").status_code, 404)
                for method, suffix, body in routes:
                    with self.subTest(method=method, suffix=suffix):
                        self.assertEqual(outsider.request(method, f"/api/jobs/{job}{suffix}", json=body).status_code, 404)
                for ident in (photo, material):
                    for variant in ("full", "thumb", "original"):
                        self.assertEqual(outsider.get(f"/images/{ident}?variant={variant}").status_code, 404)
                response = outsider.post("/api/jobs", data={"student_id": student, "day": "2026-10-15", "submit_key": "stolen"}, files={"files": ("test.jpg", raw, "image/jpeg")})
                self.assertEqual(response.status_code, 422)
            model.assert_not_called()
        self.assertEqual(self.alice.get(f"/images/{material}?variant=original").status_code, 200)
        self.assertEqual(self.alice.get(f"/api/jobs/{job}").json()["revision"], 0)

    def test_submission_keys_constraints_and_queue_cap_are_per_account(self):
        student_a, job_a, _, _, raw = self.seed(self.alice, self.alice_id, "same-key")
        student_b, job_b, _, _, _ = self.seed(self.bob, self.bob_id, "same-key")
        for client, student, job in ((self.alice, student_a, job_a), (self.bob, student_b, job_b)):
            self.assertEqual(client.get("/api/submissions/same-key").json(), {"id": job})
            response = client.post("/api/jobs", data={"student_id": student, "day": "2026-10-15", "submit_key": "same-key"}, files={"files": ("test.jpg", raw, "image/jpeg")})
            self.assertEqual(response.json(), {"id": job})
        with self.assertRaises(sqlite3.IntegrityError), app.db() as c:
            c.execute("INSERT INTO jobs(id,submit_key,user_id,student_id,day,status,created,updated) VALUES('bad','bad',?,?,'2026-10-15','queued',0,0)", (self.bob_id, student_a))
        with app.db() as c:
            for _ in range(5):
                c.execute("INSERT INTO jobs(id,submit_key,user_id,student_id,day,status,created,updated) VALUES(?,?,?,?,?,'queued',0,0)", (uuid.uuid4().hex, uuid.uuid4().hex, self.alice_id, student_a, "2026-10-15"))
        response = self.alice.post("/api/jobs", data={"student_id": student_a, "day": "2026-10-15", "submit_key": "sixth"}, files={"files": ("test.jpg", raw, "image/jpeg")})
        self.assertEqual(response.status_code, 429)
        response = self.bob.post("/api/jobs", data={"student_id": student_b, "day": "2026-10-15", "submit_key": "new-bob"}, files={"files": ("test.jpg", raw, "image/jpeg")})
        self.assertEqual(response.status_code, 202)

    def test_password_reset_disable_and_logout_revoke_sessions(self):
        other = TestClient(app.app)
        self.addCleanup(other.close)
        self.login(other, "alice", NEW_PASSWORD)
        self.assertEqual(self.alice.put("/api/account/password", json={"old_password": "wrong", "new_password": PASSWORD}).status_code, 400)
        response = self.alice.put("/api/account/password", json={"old_password": NEW_PASSWORD, "new_password": PASSWORD})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(other.get("/api/me").status_code, 401)
        self.login(self.alice, "alice")
        self.assertEqual(self.admin.put(f"/api/admin/users/{self.alice_id}/password", json={"password": NEW_PASSWORD}).status_code, 200)
        self.assertEqual(self.alice.get("/api/me").status_code, 401)
        self.login(self.alice, "alice", NEW_PASSWORD)
        self.assertEqual(self.alice.get("/api/account/usage").status_code, 403)
        self.assertEqual(self.alice.put("/api/account/password", json={"old_password": NEW_PASSWORD, "new_password": PASSWORD}).status_code, 200)
        self.login(self.alice, "alice")
        self.assertEqual(self.admin.put(f"/api/admin/users/{self.alice_id}/status", json={"enabled": False}).status_code, 200)
        self.assertEqual(self.alice.get("/api/me").status_code, 401)
        self.assertEqual(self.alice.post("/api/login", json={"username": "alice", "password": PASSWORD}).status_code, 401)
        self.admin.put(f"/api/admin/users/{self.alice_id}/status", json={"enabled": True})
        self.assertEqual(self.alice.get("/api/me").status_code, 401)
        self.login(self.alice, "alice")
        self.login(other, "alice")
        self.assertEqual(self.alice.post("/api/logout-all").status_code, 200)
        self.assertEqual(other.get("/api/me").status_code, 401)

    def test_admin_privileges_csrf_identity_and_login_limit(self):
        for url in ("/api/admin/users", "/api/admin/usage"):
            self.assertEqual(self.alice.get(url).status_code, 403)
        self.assertEqual(self.alice.post("/api/admin/users", json={"username": "charlie", "display_name": "C", "password": PASSWORD}).status_code, 403)
        self.assertEqual(self.admin.put(f"/api/admin/users/{self.admin_id}/status", json={"enabled": False}).status_code, 422)
        self.assertEqual(self.alice.get("/api/students", headers={"X-User-ID": self.bob_id}).status_code, 401)
        self.assertEqual(self.admin.put(f"/api/admin/users/{self.alice_id}/status", json={"enabled": False}, headers={"X-CSRF-Token": "wrong"}).status_code, 403)
        response = self.admin.post("/api/admin/users", json={"username": "alice", "display_name": "A", "password": PASSWORD})
        self.assertEqual(response.status_code, 409)
        self.assertNotIn("password_hash", self.admin.get("/api/admin/users").text)
        with patch.object(app, "check_password") as check:
            response = self.alice.post("/api/login", json={"username": "missing", "password": "wrong", "ignored": "x" * app.MAX_LOGIN_REQUEST})
            self.assertEqual(response.status_code, 413)
            payload = json.dumps({"username": "missing", "password": "wrong", "ignored": "x" * app.MAX_LOGIN_REQUEST})
            response = self.alice.post("/api/login", content=payload, headers={"Content-Type": "application/json", "Content-Length": "1"})
            self.assertEqual(response.status_code, 413)
            async def chunks():
                yield b'{"username":"missing","password":"wrong","ignored":"'
                yield b"x" * app.MAX_LOGIN_REQUEST
                yield b'"}'
            async def send_chunked():
                transport = app.httpx.ASGITransport(app=app.app)
                async with app.httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                    return await client.post("/api/login", content=chunks(), headers={"Content-Type": "application/json"})
            self.assertEqual(asyncio.run(send_chunked()).status_code, 413)
            check.assert_not_called()
        app.login_attempts.clear()
        for _ in range(10):
            self.assertEqual(self.alice.post("/api/login", json={"username": "missing", "password": "wrong"}).status_code, 401)
        self.assertEqual(self.alice.post("/api/login", json={"username": "missing", "password": "wrong"}).status_code, 429)
        self.assertEqual(self.bob.get("/api/students").status_code, 200)

    def test_usage_survives_deletion_and_disabled_account_cannot_call_model(self):
        student, job, photo, _, _ = self.seed(self.alice, self.alice_id)
        price = {"min": .01, "max": .02, "currency": "CNY"}
        with app.db() as c:
            c.execute("INSERT INTO calls(job_id,user_id,kind,model,seconds,input_tokens,output_tokens,created,photo_id,pricing_json) VALUES(?,?,'grading','offline',1,100,200,?,?,?)", (job, self.alice_id, time.time(), photo, json.dumps(price)))
        expected = self.alice.get("/api/account/usage").json()
        self.assertEqual(expected["costs"], {"CNY": {"min": .01, "max": .02}})
        self.assertEqual(self.bob.get("/api/account/usage").json()["calls"], 0)
        self.assertEqual(self.alice.delete(f"/api/jobs/{job}").status_code, 200)
        self.assertEqual(self.alice.get("/api/account/usage").json(), expected)
        self.assertEqual(self.alice.delete(f"/api/students/{student}").status_code, 200)
        self.assertEqual(self.alice.get("/api/account/usage").json(), expected)
        totals = self.admin.get("/api/admin/usage").json()
        self.assertEqual(next(u for u in totals if u["user_id"] == self.alice_id)["calls"], 1)
        _, job, _, _, _ = self.seed(self.bob, self.bob_id, status="queued")
        self.admin.put(f"/api/admin/users/{self.bob_id}/status", json={"enabled": False})
        with patch.object(app.httpx.Client, "post") as post:
            with self.assertRaisesRegex(ValueError, "账号已停用"):
                app.model_call(job, "grading", "offline")
            post.assert_not_called()

    def test_offline_upgrade_and_cli_recovery(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with closing(sqlite3.connect(root / "homework.sqlite3")) as c, c:
                c.execute("CREATE TABLE students(id TEXT PRIMARY KEY)")
                c.execute("INSERT INTO students VALUES('legacy')")
            (root / "images").mkdir()
            (root / "images" / "legacy.jpg").write_bytes(b"old")
            with patch.object(app, "DATA", root), patch.object(app, "DB", root / "homework.sqlite3"):
                with self.assertRaisesRegex(RuntimeError, "旧版数据库"):
                    app.init_db()
                manage.upgrade()
                with app.db() as c:
                    self.assertEqual(c.execute("SELECT COUNT(*) FROM students").fetchone()[0], 0)
                    self.assertTrue(c.execute("SELECT is_admin FROM users WHERE username='admin'").fetchone()[0])
                archive = next(root.glob("before-multiuser-*"))
                self.assertEqual((archive / "images" / "legacy.jpg").read_bytes(), b"old")
                with self.assertRaisesRegex(SystemExit, "已是多用户"):
                    manage.upgrade()
        _, inflight, _, _, _ = self.seed(self.alice, self.alice_id, status="feedbacking")
        with patch.object(manage.getpass, "getpass", return_value=PASSWORD):
            manage.setup("alice")
        self.assertEqual(app.fetch_job(inflight)["status"], "feedbacking")
        self.assertEqual(self.alice.get("/api/me").status_code, 401)
        self.login(self.alice, "alice")
        self.assertFalse(self.alice.get("/api/me").json()["user"]["is_admin"])

    def test_worker_skips_disabled_tasks_and_resumes_after_enable(self):
        _, bob_job, _, _, _ = self.seed(self.bob, self.bob_id, status="queued")
        _, alice_job, _, _, _ = self.seed(self.alice, self.alice_id, status="queued")
        self.admin.put(f"/api/admin/users/{self.bob_id}/status", json={"enabled": False})
        seen = []

        def finish(job):
            seen.append((job["id"], job["user_id"]))
            with app.db() as c:
                c.execute("UPDATE jobs SET status='review' WHERE id=?", (job["id"],))

        async def run_one():
            before = len(seen)
            task = asyncio.create_task(REAL_WORKER())
            try:
                for _ in range(100):
                    if len(seen) > before:
                        return
                    await asyncio.sleep(.01)
                self.fail("worker did not process the enabled account")
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        with patch.object(app, "grade_job", side_effect=finish):
            asyncio.run(run_one())
            self.assertEqual(seen, [(alice_job, self.alice_id)])
            self.assertEqual(app.fetch_job(bob_job)["status"], "queued")
            self.admin.put(f"/api/admin/users/{self.bob_id}/status", json={"enabled": True})
            asyncio.run(run_one())
            self.assertEqual(seen[-1], (bob_job, self.bob_id))

    def test_inflight_usage_keeps_owner_when_account_is_disabled(self):
        _, job, photo, _, _ = self.seed(self.alice, self.alice_id)

        def response(*args, **kwargs):
            self.admin.put(f"/api/admin/users/{self.alice_id}/status", json={"enabled": False})
            return app.httpx.Response(200, json={"model": "offline", "usage": {"prompt_tokens": 10, "completion_tokens": 20}, "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(RESULT)}}]})

        with patch.object(app.httpx.Client, "post", side_effect=response):
            app.model_call(job, "grading", "offline", photo_id=photo)
        with app.db() as c:
            row = c.execute("SELECT user_id,input_tokens,output_tokens FROM calls WHERE job_id=?", (job,)).fetchone()
            self.assertEqual(tuple(row), (self.alice_id, 10, 20))


if __name__ == "__main__":
    unittest.main()
