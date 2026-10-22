"""Offline integration tests. No student image is sent to any external service."""
import asyncio
import base64
import copy
import hashlib
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

TEMP = tempfile.TemporaryDirectory()
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
os.environ["DATA_DIR"] = TEMP.name
os.environ["COOKIE_SECURE"] = "false"
os.environ["PUBLIC_ORIGIN"] = ""
os.environ["DEEPSEEK_API_KEY"] = "offline-test-placeholder"

import app
import manage
from fastapi.testclient import TestClient
from PIL import Image
import httpx

app.DATA = Path(TEMP.name)
app.DB = app.DATA / "homework.sqlite3"

PASSWORD = "offline-test-password"
os.environ["ADMIN_PASSWORD_HASH"] = app.hash_password(PASSWORD)
GRADING = {"questions": [{"page": 1, "number": "1", "question": "界面测试题：2+3", "student_answer": "6", "status": "incorrect", "expected_answer": "5", "explanation": "此内容是离线模拟响应，不代表照片批改。", "knowledge_point": "加法"}], "observations": [], "warnings": ["离线模拟结果，非真实作业批改"]}


def jpeg():
    buffer = io.BytesIO()
    Image.new("RGB", (100, 180), "white").save(buffer, "JPEG")
    return buffer.getvalue()


def original_pdf(pages=2):
    buffer=io.BytesIO()
    images=[Image.new('RGB',(100,180),'red' if i==0 else 'blue') for i in range(pages)]
    images[0].save(buffer,'PDF',save_all=True,append_images=images[1:])
    for image in images:image.close()
    return buffer.getvalue()


class WorkflowTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        TEMP.cleanup()

    def setUp(self):
        self.anchor_patch = patch.object(app, 'detect_anchors', return_value=[])
        self.anchor_patch.start()
        self.addCleanup(self.anchor_patch.stop)
        self.context = TestClient(app.app)
        self.client = self.context.__enter__()
        response = self.client.post("/api/login", json={"username": "admin", "password": PASSWORD})
        self.client.headers["X-CSRF-Token"] = response.json()["csrf"]
        self.user_id = self.client.get("/api/me").json()["user"]["user_id"]
        self.student = self.client.post("/api/students", json={"name": "离线测试学生", "grade": "六年级"}).json()["id"]

    def tearDown(self):
        self.context.__exit__(None, None, None)

    def submit(self, raw=None, key=None):
        return self.client.post("/api/jobs", data={"student_id": self.student, "day": "2026-10-03", "submit_key": key or uuid.uuid4().hex}, files=[("files", ("sample.jpg", raw or jpeg(), "image/jpeg"))])

    def wait(self, job_id):
        for _ in range(100):
            job = self.client.get(f"/api/jobs/{job_id}").json()
            if job["status"] not in app.BUSY:
                return job
            time.sleep(.05)
        self.fail("worker did not finish")

    def ready_job(self):
        with patch.object(app, "model_call", return_value=copy.deepcopy(GRADING)):
            response = self.submit()
            self.assertEqual(response.status_code, 202, response.text)
            return self.wait(response.json()["id"])

    def review(self, job, result=None, checked=True):
        response = self.client.put(f"/api/jobs/{job['id']}/review", json={"revision": job["revision"], "result": result or job["result"], "reviewed": checked, "notes_checked": checked, "teacher_notes": ""})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_live_grading_progress_and_retry_keeps_completed_pages(self):
        waiting, release = threading.Event(), threading.Event()
        seen = []

        def model(job_id, kind, prompt, images=(), photo_id=None):
            current = app.fetch_job(job_id)
            seen.append(current["progress"])
            if current["progress"]["page"] == 2:
                waiting.set()
                if not release.wait(5):
                    raise AssertionError("offline test did not release model")
                raise httpx.ReadTimeout("offline timeout")
            return copy.deepcopy(GRADING)

        with patch.object(app, "model_call", side_effect=model):
            response = self.client.post("/api/jobs", data={"student_id": self.student, "day": "2026-10-06", "submit_key": uuid.uuid4().hex}, files=[("files", ("one.jpg", jpeg(), "image/jpeg")), ("files", ("two.jpg", jpeg(), "image/jpeg"))])
            self.assertEqual(response.status_code, 202, response.text)
            job_id = response.json()["id"]
            try:
                self.assertTrue(waiting.wait(4))
                current = self.client.get(f"/api/jobs/{job_id}").json()
                self.assertEqual(current["status"], "processing")
                self.assertEqual(current["progress"]["stage"], "grading")
                self.assertEqual(current["progress"]["page"], 2)
                self.assertEqual([p["recognized"] for p in current["photos"]], [1, 0])
                self.assertEqual(seen[0]["stage"], "grading")
                self.assertEqual(seen[0]["started_at"], current["progress"]["started_at"])
                self.assertGreaterEqual(current["progress"]["stage_started_at"], current["progress"]["started_at"])
            finally:
                release.set()
            failed = self.wait(job_id)
        self.assertEqual(failed["status"], "failed")
        self.assertIn("超时", failed["error"])
        with patch.object(app, "model_call", return_value=copy.deepcopy(GRADING)) as retry:
            response = self.client.post(f"/api/jobs/{job_id}/retry", json={"revision": failed["revision"]})
            self.assertEqual(response.status_code, 202, response.text)
            ready = self.wait(job_id)
        self.assertEqual(ready["status"], "review")
        self.assertIsNone(ready["progress"])
        self.assertTrue(all(p["recognized"] for p in ready["photos"]))
        self.assertEqual(retry.call_count, 1, "completed page must not be billed again")
        app.grade_progress(job_id, "grading", 1)
        self.assertIsNone(app.fetch_job(job_id)["progress"], "late progress cannot overwrite a finished task")

    def test_full_review_feedback_archive_and_stale_reply(self):
        job = self.ready_job()
        self.assertEqual(job["status"], "review")
        route = f"/api/jobs/{job['id']}"
        self.assertEqual(self.client.post(route + "/confirm", json={"revision": job["revision"]}).status_code, 422)
        job = self.review(job)
        with patch.object(app, "model_call", return_value={"feedback": "这是一条模拟家长回复，请依据实际作业核对。", "history_evidence": []}):
            response = self.client.post(route + "/feedback", json={"revision": job["revision"]})
            self.assertEqual(response.status_code, 202)
            job = self.wait(job["id"])
        self.assertEqual(job["feedback_revision"], job["revision"])
        response = self.client.post(route + "/confirm", json={"revision": job["revision"]})
        self.assertEqual(response.status_code, 200)
        job = response.json()
        modified = copy.deepcopy(job["result"])
        modified["questions"][0]["status"] = "correct"
        changed = self.review(job, modified)
        self.assertEqual(changed["status"], "review")
        self.assertIsNone(changed["feedback_revision"])
        self.assertEqual(self.client.post(route + "/confirm", json={"revision": changed["revision"]}).status_code, 422)
        self.assertEqual(self.client.put(route + "/review", json={"revision": job["revision"], "result": modified}).status_code, 409)

    def test_auth_csrf_origin_and_private_images(self):
        job = self.ready_job()
        url = "/images/" + job["photos"][0]["id"]
        self.assertEqual(self.client.get(url).status_code, 200)
        cookies = dict(self.client.cookies)
        self.client.cookies.clear()
        self.assertEqual(self.client.get(url).status_code, 401)
        self.assertEqual(self.client.get("/api/students").status_code, 401)
        self.client.cookies.update(cookies)
        self.assertEqual(self.client.post("/api/students", json={"name":"x","grade":"1"}, headers={"X-CSRF-Token":"wrong"}).status_code, 403)
        self.assertEqual(self.client.post("/api/students", json={"name":"x","grade":"1"}, headers={"Origin":"https://evil.example"}).status_code, 403)
        self.assertEqual(self.client.get(url + "?variant=../../.env").status_code, 422)
        response = self.client.get("/")
        self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
        self.assertNotIn(os.environ["DEEPSEEK_API_KEY"], response.text)
        self.assertIn('javascript',self.client.get('/static/app.js').headers['content-type'])

    def test_duplicate_upload_and_reject_broken_photo(self):
        key = uuid.uuid4().hex
        with patch.object(app, "model_call", return_value=copy.deepcopy(GRADING)):
            one, two = self.submit(key=key), self.submit(key=key)
            self.assertEqual(one.json()["id"], two.json()["id"])
            self.wait(one.json()["id"])
        before = set((app.DATA / "images").iterdir())
        self.assertEqual(self.submit(raw=b"not an image").status_code, 422)
        self.assertEqual(before, set((app.DATA / "images").iterdir()))
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY":""}):
            self.assertEqual(self.submit().status_code, 503)

    def test_failed_call_preserves_upload_and_retry(self):
        with patch.object(app, "model_call", side_effect=ValueError("API 余额不足")):
            job = self.wait(self.submit().json()["id"])
        self.assertEqual(job["status"], "failed")
        self.assertIn("余额", job["error"])
        self.assertEqual(self.client.get("/images/" + job["photos"][0]["id"]).status_code, 200)
        with patch.object(app, "model_call", return_value=copy.deepcopy(GRADING)):
            self.assertEqual(self.client.post(f"/api/jobs/{job['id']}/retry",json={"revision":job["revision"]}).status_code,202)
            self.assertEqual(self.wait(job["id"])["status"],"review")

    def test_model_schema_crop_and_missing_page(self):
        job = self.ready_job()
        incorrect = copy.deepcopy(job["result"])
        incorrect["questions"][0]["page"] = 2
        self.assertEqual(self.client.put(f"/api/jobs/{job['id']}/review",json={"revision":job["revision"],"result":incorrect}).status_code,422)
        body={"revision":job["revision"],"question_index":0,"photo_id":job["photos"][0]["id"],"x":.1,"y":.1,"width":.6,"height":.6}
        revised=copy.deepcopy(GRADING);revised["questions"][0]["student_answer"]="5";revised["questions"][0]["status"]="correct"
        with patch.object(app,"model_call",return_value=revised):
            response=self.client.post(f"/api/jobs/{job['id']}/crop",json=body)
        self.assertEqual(response.status_code,200,response.text)
        cropped=response.json()
        self.assertEqual(cropped["result"]["questions"][0]["student_answer"],"5")
        self.assertEqual(cropped["revision"],job["revision"]+1)
        self.assertFalse(cropped["reviewed"])
        self.assertEqual(cropped['result']['questions'][0]['bbox'],{'x':.1,'y':.1,'width':.6,'height':.6})
        self.assertEqual(cropped['result']['questions'][0]['bbox_source'],'teacher')
        body["revision"]=cropped["revision"];body["width"]=1
        self.assertEqual(self.client.post(f"/api/jobs/{job['id']}/crop",json=body).status_code,422)

    def test_history_excludes_drafts_other_students_and_future(self):
        archived=self.review(self.ready_job())
        route=f"/api/jobs/{archived['id']}"
        archived=self.client.put(route+"/feedback",json={"revision":archived["revision"],"feedback":"老师手写回复"}).json()
        self.client.post(route+"/confirm",json={"revision":archived["revision"]})
        draft=self.ready_job()
        current=self.review(self.ready_job())
        other=self.client.post('/api/students',json={'name':'另一名学生','grade':'六年级'}).json()['id']
        with app.db() as c:
            for student,day in [(self.student,'2026-10-04'),(other,'2026-10-02')]:
                c.execute("INSERT INTO jobs(id,submit_key,user_id,student_id,day,status,result,created,updated) VALUES(?,?,?,?,?,'confirmed',?,?,?)",(uuid.uuid4().hex,uuid.uuid4().hex,self.user_id,student,day,json.dumps(GRADING),time.time(),time.time()))
        prompts=[]
        def answer(job_id,kind,prompt,images=()):
            prompts.append(prompt)
            return {"feedback":"同知识点的重复问题需要继续订正。","history_evidence":[{"job_id":archived["id"],"claim":"模拟历史观察"}]}
        with patch.object(app,"model_call",side_effect=answer):
            self.client.post(f"/api/jobs/{current['id']}/feedback",json={"revision":current["revision"]})
            current=self.wait(current["id"])
        content=json.loads(prompts[0].split("\n")[-1])
        self.assertEqual([h["id"] for h in content["history"]],[archived["id"]])
        self.assertNotIn("离线测试学生",prompts[0])
        self.assertEqual(current["evidence"][0]["job_id"],archived["id"])
        before = current
        self.client.delete(route)
        current=self.client.get(f"/api/jobs/{current['id']}").json()
        self.assertEqual(current["evidence"],[])
        self.assertIsNone(current["feedback_revision"])
        self.assertGreater(current['revision'],before['revision'])
        self.assertGreater(current['updated'],before['updated'])
        self.assertEqual(self.client.put(f"/api/jobs/{current['id']}/feedback",json={'revision':before['revision'],'feedback':before['feedback']}).status_code,409)

    def test_history_changes_invalidate_dependent_replies(self):
        source=self.review(self.ready_job());target=self.review(self.ready_job())
        source_route=f"/api/jobs/{source['id']}";target_route=f"/api/jobs/{target['id']}"
        for operation in ('review','crop','judge-text'):
            with self.subTest(operation=operation):
                with app.db() as c:
                    c.execute("UPDATE jobs SET status='confirmed' WHERE id=?",(source['id'],))
                    c.execute("UPDATE jobs SET evidence=?,feedback='引用旧历史的回复',feedback_revision=revision,status='confirmed' WHERE id=?",
                              (json.dumps([{'job_id':source['id'],'result':source['result']}]),target['id']))
                source=self.client.get(source_route).json();before=self.client.get(target_route).json()
                if operation=='review':
                    value=copy.deepcopy(source['result']);value['questions'][0].update(status='correct',student_answer='5')
                    source=self.review(source,value)
                elif operation=='crop':
                    with patch.object(app,'model_call',return_value=copy.deepcopy(GRADING)):
                        response=self.client.post(source_route+'/crop',json={'revision':source['revision'],'question_index':0,'photo_id':source['photos'][0]['id'],'x':0,'y':0,'width':1,'height':1})
                    self.assertEqual(response.status_code,200,response.text);source=response.json()
                else:
                    with patch.object(app,'model_call',return_value={'status':'correct','expected_answer':'5','explanation':'模拟判定','knowledge_point':'加法'}):
                        response=self.client.post(source_route+'/judge-text',json={'revision':source['revision'],'question_index':0})
                    self.assertEqual(response.status_code,200,response.text);source=response.json()
                after=self.client.get(target_route).json()
                self.assertEqual(after['evidence'],[]);self.assertIsNone(after['feedback_revision'])
                self.assertEqual(after['status'],'review');self.assertGreater(after['revision'],before['revision'])
                self.assertGreater(after['updated'],before['updated']);self.assertEqual(after['feedback'],before['feedback'])
                self.assertEqual(self.client.post(target_route+'/confirm',json={'revision':after['revision']}).status_code,422)
                self.assertEqual(self.client.put(target_route+'/feedback',json={'revision':before['revision'],'feedback':before['feedback']}).status_code,409)
        # Invalidation must not discard a concurrent paid crop/text judgment's result.
        with app.db() as c:
            c.execute("UPDATE jobs SET evidence=?,status='judging',feedback_revision=revision WHERE id=?",
                      (json.dumps([{'job_id':source['id']}]),target['id']))
        before=self.client.get(target_route).json()
        value=copy.deepcopy(source['result']);value['questions'][0]['knowledge_point']='整数加法'
        self.review(source,value)
        after=self.client.get(target_route).json()
        self.assertEqual(after['status'],'judging');self.assertEqual(after['revision'],before['revision'])
        self.assertEqual(after['evidence'],[]);self.assertIsNone(after['feedback_revision'])

    def test_history_change_during_feedback_does_not_save_stale_comparison(self):
        source=self.review(self.ready_job());target=self.review(self.ready_job())
        with app.db() as c:
            c.execute("UPDATE jobs SET status='confirmed' WHERE id=?",(source['id'],))
            c.execute("UPDATE jobs SET status='feedbacking' WHERE id=?",(target['id'],))
        def response(*args,**kwargs):
            value=copy.deepcopy(source['result']);value['questions'][0]['status']='correct'
            self.review(source,value)
            return {'feedback':'不应保存的旧历史比较','history_evidence':[{'job_id':source['id'],'claim':'曾有错误'}]}
        with patch.object(app,'model_call',side_effect=response):
            with self.assertRaisesRegex(ValueError,'历史作业已变化'):
                app.feedback_job(app.fetch_job(target['id']))
        after=self.client.get(f"/api/jobs/{target['id']}").json()
        self.assertEqual(after['feedback'],'');self.assertIsNone(after['feedback_revision'])

    def test_crop_notes_keep_current_question_links_and_old_records(self):
        with patch.object(app,'model_call',side_effect=lambda *args,**kwargs:copy.deepcopy(GRADING)):
            response=self.client.post('/api/jobs',data={'student_id':self.student,'day':'2026-10-03','submit_key':uuid.uuid4().hex},
                                      files=[('files',('one.jpg',jpeg(),'image/jpeg')),('files',('two.jpg',jpeg(),'image/jpeg'))])
            job=self.wait(response.json()['id'])
        ids=[q['id'] for q in job['result']['questions']]
        old=copy.deepcopy(job['result']);old['observations']=['旧观察'];old['warnings']=['再次需要核对','其他题的疑问']
        old['note_links']={'observation:旧观察':{'scope':'questions','question_ids':[ids[1]],'checked':False},
                           'warning:再次需要核对':{'scope':'questions','question_ids':ids,'checked':False},
                           'warning:其他题的疑问':{'scope':'questions','question_ids':[ids[0]],'checked':False}}
        old['warning_states']={'再次需要核对':'resolved'};job=self.review(job,old)
        revised=copy.deepcopy(GRADING);revised.update(observations=['第2页：可见计算步骤'],warnings=['再次需要核对','新疑问'])
        revised['questions'][0].update(observation_indices=[0],warning_indices=[0,1])
        body={'revision':job['revision'],'question_index':1,'photo_id':job['photos'][1]['id'],'x':0,'y':0,'width':1,'height':1}
        with patch.object(app,'model_call',return_value=revised) as model:
            response=self.client.post(f"/api/jobs/{job['id']}/crop",json=body)
        self.assertEqual(response.status_code,200,response.text);current=response.json()['result']
        self.assertIn('实际是第2页',model.call_args.args[2])
        self.assertEqual(current['questions'][1]['id'],ids[1]);self.assertEqual(current['questions'][1]['page'],2)
        self.assertTrue(current['questions'][0]['reviewed']);self.assertTrue(current['notes_pending'])
        self.assertTrue(current['note_links']['observation:旧观察']['superseded'])
        self.assertFalse(current['note_links']['observation:第2页：可见计算步骤']['superseded'])
        self.assertEqual(current['note_links']['observation:第2页：可见计算步骤']['question_ids'],[ids[1]])
        self.assertEqual(current['note_links']['warning:再次需要核对']['question_ids'],ids)
        self.assertNotIn('再次需要核对',current['warning_states'])
        self.assertEqual(current['note_links']['warning:新疑问']['question_ids'],[ids[1]])
        self.assertEqual(app.feedback_basis(current)['observations'],['第2页：可见计算步骤'])
        self.assertIn('新疑问',app.feedback_basis(current)['warnings']);self.assertIn('其他题的疑问',current['warnings'])
        # Existing record limits must fail without silently dropping another question's notes.
        overflow=copy.deepcopy(revised);overflow['warnings']=[f'新疑问{i}' for i in range(20)]
        body['revision']=response.json()['revision']
        with patch.object(app,'model_call',return_value=overflow):
            self.assertEqual(self.client.post(f"/api/jobs/{job['id']}/crop",json=body).status_code,502)
        self.assertEqual(self.client.get(f"/api/jobs/{job['id']}").json()['result'],current)

    def test_restart_marks_inflight_for_manual_retry(self):
        job=self.ready_job()
        with app.db() as c:
            c.execute("UPDATE jobs SET status='feedbacking' WHERE id=?",(job["id"],))
        app.recover_interrupted_jobs()
        self.assertEqual(app.fetch_job(job["id"])["status"],"failed")
        self.assertIsNotNone(app.fetch_job(job["id"])["result"])

    def test_revoked_review_leaves_confirmed_history_and_blocks_archive(self):
        job=self.review(self.ready_job())
        route=f"/api/jobs/{job['id']}"
        job=self.client.put(route+'/feedback',json={'revision':job['revision'],'feedback':'老师手写确认回复'}).json()
        job=self.client.post(route+'/confirm',json={'revision':job['revision']}).json()
        self.assertEqual(job['status'],'confirmed')
        revoked=self.review(job,checked=False)
        self.assertEqual(revoked['status'],'review')
        self.assertIsNone(revoked['feedback_revision'])
        self.assertGreater(revoked['revision'],job['revision'])
        self.assertEqual(self.client.post(route+'/confirm',json={'revision':revoked['revision']}).status_code,422)

    def test_official_request_format_and_usage_without_network(self):
        job=self.ready_job()
        payload={'choices':[{'finish_reason':'stop','message':{'content':json.dumps(GRADING)}}], 'usage':{'prompt_tokens':100,'completion_tokens':50}}
        with patch('app.httpx.Client') as client:
            post=client.return_value.__enter__.return_value.post
            post.return_value=httpx.Response(200,json=payload)
            result=app.model_call(job['id'],'grading','输出 JSON 测试',[jpeg()])
            args=post.call_args.kwargs
            self.assertEqual(result,GRADING)
            self.assertEqual(args['json']['model'],'deepseek-flash')
            self.assertEqual(args['json']['messages'][0]['role'],'user')
            self.assertTrue(args['json']['messages'][0]['content'][1]['image_url']['url'].startswith('data:image/jpeg;base64,'))
            self.assertEqual(args['json']['thinking']['type'],'enabled')
            self.assertEqual(post.call_count,1)
            payload['choices'][0]['finish_reason']='length'
            post.return_value=httpx.Response(200,json=payload)
            with self.assertRaisesRegex(ValueError,'截断'):
                app.model_call(job['id'],'grading','测试',[jpeg()])
            self.assertEqual(post.call_count,2)
        calls=app.fetch_job(job['id'])['calls']
        self.assertEqual(calls[-1]['input_tokens'],100)
        self.assertEqual(calls[-1]['output_tokens'],50)

    def test_heic_conversion(self):
        buffer=io.BytesIO()
        Image.new('RGB',(80,120),'white').save(buffer,'HEIF')
        with tempfile.TemporaryDirectory(dir=app.DATA) as folder:
            _,full,_=app.prepare_photo(buffer.getvalue(),Path(folder),uuid.uuid4().hex)
            with Image.open(app.DATA/full) as image:
                self.assertEqual(image.format,'JPEG')
                self.assertEqual(image.size,(80,120))

    def test_heic_upload_primary_orientation_original_and_mime_independence(self):
        # HEIF containers can start with a secondary image and carry camera rotation.
        with Image.new('RGB',(64,64),'green') as secondary, Image.new('RGB',(600,900),'red') as primary:
            primary.paste('blue',(0,450,600,900))
            exif=Image.Exif();exif[274]=6
            primary.info['exif']=exif.tobytes()
            buffer=io.BytesIO()
            secondary.save(buffer,'HEIF',save_all=True,append_images=[primary],primary_index=1,quality=95)
        raw=buffer.getvalue()
        expected=copy.deepcopy(GRADING);expected['questions'][0]['source_match']='matched'
        with patch.object(app,'model_call',return_value=expected) as model:
            response=self.client.post('/api/jobs',data={'student_id':self.student,'day':'2026-10-04','submit_key':uuid.uuid4().hex,
                'material_map':json.dumps([{'file_index':0,'page':1}]*2)},files=[
                    ('files',('IMG_001.HEIC',raw,'application/octet-stream')),
                    ('files',('download',raw,'image/heif-sequence')),
                    ('original_files',('original.HEIF',raw,'image/jpeg'))])
            self.assertEqual(response.status_code,202,response.text)
            job=self.wait(response.json()['id'])
            self.assertEqual(job['status'],'review',job['error'])
            self.assertEqual(model.call_count,2)
            for call in model.call_args_list:
                self.assertEqual(call.args[1],'grading')
                self.assertEqual(len(call.args[3]),2)
                for data in call.args[3]:
                    with Image.open(io.BytesIO(data)) as image:
                        self.assertEqual(image.format,'JPEG')
                        self.assertEqual(image.size,(900,600))
        self.assertEqual(len(job['materials']),1)
        for item in job['photos']+job['materials']:
            image_url='/images/'+item['id']
            self.assertEqual(self.client.get(image_url+'?variant=original').content,raw)
            for variant,size in [('full',(900,600)),('thumb',(440,293))]:
                with Image.open(io.BytesIO(self.client.get(image_url+'?variant='+variant).content)) as image:
                    self.assertEqual(image.format,'JPEG')
                    self.assertEqual(image.size,size)
                    self.assertIn(image.getexif().get(274),[None,1])
                    left=image.getpixel((image.width//4,image.height//2))
                    right=image.getpixel((3*image.width//4,image.height//2))
                    self.assertGreater(left[2],left[0]+100)
                    self.assertGreater(right[0],right[2]+100)
        cookies=dict(self.client.cookies);self.client.cookies.clear()
        self.assertEqual(self.client.get(image_url+'?variant=original').status_code,401)
        self.client.cookies.update(cookies)
        with patch.object(app,'model_call') as model:
            response=self.client.post('/api/jobs',data={'student_id':self.student,'day':'2026-10-04','submit_key':uuid.uuid4().hex},
                files=[('files',('fake.heic',b'not an image','image/heic'))])
            self.assertEqual(response.status_code,422,response.text)
            self.assertFalse(model.called)

    def test_heif_preview_private_bounded_no_jobs_files_or_model_calls(self):
        with Image.new('RGB',(800,600),'red') as image:
            exif=Image.Exif();exif[274]=6
            buffer=io.BytesIO();image.save(buffer,'HEIF',exif=exif.tobytes())
        raw=buffer.getvalue()
        image_files=set((app.DATA/'images').rglob('*'))
        with app.db() as connection:
            counts=[connection.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ['jobs','calls']]
        def preview(data=raw,**kwargs):
            return self.client.post('/api/photos/preview',files={'file':('download.HEIF',data,'application/octet-stream')},**kwargs)
        with patch.object(app,'model_call') as model:
            response=preview()
            self.assertEqual(response.status_code,200,response.text[:100])
            self.assertEqual(response.headers['content-type'],'image/jpeg')
            self.assertEqual(response.headers['cache-control'],'no-store')
            with Image.open(io.BytesIO(response.content)) as image:
                self.assertEqual(image.format,'JPEG')
                self.assertEqual(image.size,(450,600))
                self.assertIn(image.getexif().get(274),[None,1])
            csrf=self.client.headers.pop('X-CSRF-Token')
            self.assertEqual(preview().status_code,403)
            self.client.headers['X-CSRF-Token']=csrf
            cookies=dict(self.client.cookies);self.client.cookies.clear()
            self.assertEqual(preview().status_code,401)
            self.client.cookies.update(cookies)
            self.assertEqual(preview(b'not a HEIF image').status_code,422)
            with patch.object(app,'MAX_FILE',64):
                self.assertEqual(preview(b'x'*65).status_code,413)
                self.assertEqual(preview(headers={'Content-Length':str(64+64*1024+1)}).status_code,413)
            self.assertFalse(model.called)
        self.assertEqual(image_files,set((app.DATA/'images').rglob('*')))
        with app.db() as connection:
            self.assertEqual(counts,[connection.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ['jobs','calls']])

    def test_manual_location_has_no_api_cost_and_preserves_confirmed_feedback(self):
        job=self.review(self.ready_job())
        route=f"/api/jobs/{job['id']}"
        job=self.client.put(route+'/feedback',json={'revision':job['revision'],'feedback':'老师确认的回复'}).json()
        job=self.client.post(route+'/confirm',json={'revision':job['revision']}).json()
        body={'revision':job['revision'],'question_index':0,'photo_id':job['photos'][0]['id'],'bbox':{'x':.1,'y':.2,'width':.6,'height':.3}}
        with patch.object(app,'model_call') as model:
            saved=self.client.put(route+'/location',json=body)
            self.assertEqual(saved.status_code,200,saved.text)
            self.assertFalse(model.called)
        current=saved.json()
        self.assertEqual(current['status'],'confirmed')
        self.assertEqual(current['feedback_revision'],current['revision'])
        self.assertEqual(current['result']['questions'][0]['bbox'],body['bbox'])
        self.assertEqual(current['result']['questions'][0]['bbox_source'],'teacher')
        self.assertEqual(current['calls'],job['calls'])
        self.assertEqual(self.client.put(route+'/location',json=body).status_code,409)
        body['revision']=current['revision'];body['bbox']['width']=1
        self.assertEqual(self.client.put(route+'/location',json=body).status_code,422)
        body['bbox']['width']=.5;body['photo_id']=self.ready_job()['photos'][0]['id']
        self.assertEqual(self.client.put(route+'/location',json=body).status_code,422)

    def test_each_page_usage_bad_box_and_resume_only_missing_page(self):
        requests=[]
        def answer(job_id,kind,prompt,images=(),photo_id=None):
            requests.append(photo_id)
            self.assertEqual(len(images),1)
            if len(requests)==2:
                raise ValueError('模拟第二页失败')
            value=copy.deepcopy(GRADING)
            value['questions'][0]['bbox']={'x':.9,'y':0,'width':.8,'height':.2}  # Generated coordinates are ignored.
            value['questions'][0]['anchor_ids']=[999] if len(requests)==1 else [1]
            payload={'model':'deepseek-flash','choices':[{'finish_reason':'stop','message':{'content':json.dumps(value)}}],
                     'usage':{'prompt_tokens':1000,'completion_tokens':500,'prompt_cache_hit_tokens':400,'prompt_cache_miss_tokens':600,'completion_tokens_details':{'reasoning_tokens':200}}}
            with patch('app.httpx.Client') as remote:
                remote.return_value.__enter__.return_value.post.return_value=httpx.Response(200,json=payload)
                return actual_call(job_id,kind,prompt,images,photo_id=photo_id)
        actual_call=app.model_call
        with patch.object(app,'model_call',side_effect=answer), patch.object(app,'detect_anchors',return_value=[{'id':1,'text':'2+3','bbox':{'x':.1,'y':.2,'width':.5,'height':.2}}]):
            response=self.client.post('/api/jobs',data={'student_id':self.student,'day':'2026-10-04','submit_key':uuid.uuid4().hex},files=[('files',('one.jpg',jpeg(),'image/jpeg')),('files',('two.jpg',jpeg(),'image/jpeg'))])
            job=self.wait(response.json()['id'])
            self.assertEqual(job['status'],'failed')
            self.assertEqual(len(job['calls']),1)
            self.assertTrue(job['photos'][0]['recognized'])
            self.assertFalse(job['photos'][1]['recognized'])
            self.client.post(f"/api/jobs/{job['id']}/retry",json={'revision':job['revision']})
            job=self.wait(job['id'])
        self.assertEqual(job['status'],'review')
        self.assertEqual(requests,[job['photos'][0]['id'],job['photos'][1]['id'],job['photos'][1]['id']])
        self.assertEqual([c['page'] for c in job['calls']],[1,2])
        self.assertEqual([q['page'] for q in job['result']['questions']],[1,2])
        self.assertIsNone(job['result']['questions'][0]['bbox'])
        self.assertIsNotNone(job['result']['questions'][1]['bbox'])
        self.assertAlmostEqual(job['result']['questions'][1]['bbox']['y'],.197)
        usage=job['calls'][0]['usage']
        self.assertEqual(usage['prompt_cache_hit_tokens'],400)
        price=job['calls'][0]['pricing']
        self.assertEqual(price['currency'],'CNY')
        self.assertAlmostEqual(price['min'],(400*.02+600*1+500*4)/1_000_000)
        self.assertAlmostEqual(price['max'],2*price['min'])

    def test_page_relocation_preserves_review_and_manual_boxes_and_logs_usage(self):
        job=self.review(self.ready_job())
        with app.db() as c:
            c.execute("UPDATE jobs SET status='confirmed',feedback='已确认回复',feedback_revision=revision WHERE id=?",(job['id'],))
        job=self.client.get(f"/api/jobs/{job['id']}").json()
        source=copy.deepcopy(job['result'])
        manual=copy.deepcopy(source['questions'][0]);manual.update(number='2',bbox={'x':.5,'y':.5,'width':.2,'height':.2},bbox_source='teacher')
        source['questions'].append(manual)
        with app.db() as c:c.execute('UPDATE jobs SET result=? WHERE id=?',(json.dumps(source),job['id']))
        anchors=[{'id':1,'text':'2+3','bbox':{'x':.2,'y':.3,'width':.2,'height':.08}}]
        payload={'model':'deepseek-flash','choices':[{'message':{'content':json.dumps({'locations':[{'question_index':0,'anchor_ids':[1]}]})}}], 'usage':{'prompt_tokens':1000,'completion_tokens':100}}
        route=f"/api/jobs/{job['id']}/locate"
        body={'revision':job['revision'],'photo_id':job['photos'][0]['id']}
        with patch.object(app,'detect_anchors',return_value=anchors),patch('app.httpx.Client') as remote:
            remote.return_value.__enter__.return_value.post.return_value=httpx.Response(200,json=payload)
            response=self.client.post(route,json=body)
            self.assertEqual(response.status_code,200,response.text)
            sent=remote.return_value.__enter__.return_value.post.call_args.kwargs['json']
            self.assertEqual(len(sent['messages'][0]['content']),2)
        current=response.json();q=current['result']['questions'][0]
        self.assertEqual(q['bbox_source'],'ocr');self.assertAlmostEqual(q['bbox']['y'],.297)
        for field in ['question','student_answer','status','expected_answer','explanation','knowledge_point']:
            self.assertEqual(q[field],source['questions'][0][field])
        self.assertEqual(current['result']['questions'][1],manual)
        self.assertEqual(current['status'],'confirmed');self.assertEqual(current['reviewed'],1)
        self.assertEqual(current['feedback_revision'],current['revision']);self.assertEqual(current['feedback'],'已确认回复')
        self.assertEqual(current['calls'][-1]['kind'],'location');self.assertEqual(current['calls'][-1]['page'],1)
        self.assertEqual(self.client.post(route,json=body).status_code,409)
        body['revision']=current['revision']
        with patch.object(app,'model_call',return_value={'locations':[{'question_index':0,'anchor_ids':[999]}]}):
            self.assertEqual(self.client.post(route,json=body).status_code,502)
        unchanged=self.client.get(f"/api/jobs/{job['id']}").json()
        self.assertEqual(unchanged['result'],current['result']);self.assertEqual(unchanged['revision'],current['revision'])
        self.assertEqual(unchanged['status'],'confirmed')

    def test_localization_rejects_shared_unknown_and_missing_anchors(self):
        from localization import apply_anchors
        anchors=[{'id':1,'bbox':{'x':.1,'y':.2,'width':.2,'height':.1}},{'id':2,'bbox':{'x':.35,'y':.2,'width':.1,'height':.1}}]
        questions=[{'anchor_ids':[1]},{'anchor_ids':[1]},{'anchor_ids':[999]},{'bbox':{'x':0,'y':0,'width':1,'height':1}}]
        self.assertEqual(apply_anchors(questions,anchors),0)
        self.assertTrue(all(q['bbox'] is None for q in questions))
        q={'anchor_ids':[1,2]};self.assertEqual(apply_anchors([q],anchors),1)
        self.assertAlmostEqual(q['bbox']['width'],.356)
        with app.db() as c:
            c.execute("UPDATE jobs SET status='locating',location_previous_status='review' WHERE id=?",(self.ready_job()['id'],))
        app.recover_interrupted_jobs()
        with app.db() as c:self.assertEqual(c.execute("SELECT COUNT(*) FROM jobs WHERE status='locating'").fetchone()[0],0)

    def test_price_unknown_cache_and_custom_snapshot(self):
        usage={'prompt_tokens':1000,'completion_tokens':500}
        default={k:'' for k in ['PRICE_INPUT_MISS','PRICE_INPUT_HIT','PRICE_OUTPUT']}
        with patch.dict(os.environ,default):
            price=app.price_usage('deepseek-flash',usage)
            self.assertEqual(price['currency'],'CNY')
            self.assertGreater(price['max'],price['min'])
            self.assertIn('缓存用量缺失',price['note'])
            self.assertIsNone(app.price_usage('unknown-model',usage))
            self.assertIsNone(app.price_usage('deepseek-flash',{}))
        with patch.dict(os.environ,{'PRICE_INPUT_MISS':'2','PRICE_INPUT_HIT':'.1','PRICE_OUTPUT':'8','PRICE_CURRENCY':'CNY'}):
            price=app.price_usage('custom-model',{**usage,'prompt_cache_hit_tokens':200})
            self.assertEqual(price['currency'],'CNY')
            self.assertAlmostEqual(price['min'],(200*.1+800*2+500*8)/1_000_000)
            self.assertEqual(price['min'],price['max'])
        with patch.dict(os.environ,{'PRICE_INPUT_MISS':'nan','PRICE_INPUT_HIT':'.1','PRICE_OUTPUT':'8'}):
            self.assertIsNone(app.price_usage('deepseek-flash',usage))

    def test_legacy_official_usd_estimate_displays_cny_without_rewriting_snapshot(self):
        job=self.ready_job()
        legacy={'min':.001,'max':.002,'currency':'USD','note':'官方 Flash 2026-10-04 单价',
                'rates':{'input_miss':.15,'input_hit':.003,'output':.6,'peak_factor':2}}
        custom={**legacy,'rates':{**legacy['rates'],'peak_factor':1}}
        with app.db() as c:
            for pricing in (legacy,custom):
                c.execute("INSERT INTO calls(job_id,user_id,kind,model,seconds,input_tokens,output_tokens,created,pricing_json) VALUES(?,?,'grading','deepseek-flash',1,1000,500,?,?)",
                          (job['id'],self.user_id,time.time(),json.dumps(pricing)))
        calls=self.client.get(f"/api/jobs/{job['id']}").json()['calls']
        self.assertEqual(calls[0]['pricing']['currency'],'CNY')
        self.assertAlmostEqual(calls[0]['pricing']['min'],.001/.15)
        self.assertAlmostEqual(calls[0]['pricing']['max'],.002/.15)
        self.assertEqual(calls[1]['pricing'],custom)
        with app.db() as c:
            self.assertEqual(json.loads(c.execute('SELECT pricing_json FROM calls WHERE id=?',(calls[0]['id'],)).fetchone()[0]),legacy)

    def test_legacy_database_migration_keeps_usage_and_photos(self):
        job=self.ready_job()
        with tempfile.TemporaryDirectory() as temp:
            target=Path(temp)/'legacy.sqlite3'
            with app.db() as original,closing(app.sqlite3.connect(target)) as legacy:
                original.backup(legacy)
                for name in ['photo_id','usage_json','pricing_json']:
                    legacy.execute(f'ALTER TABLE calls DROP COLUMN {name}')
                legacy.execute('ALTER TABLE photos DROP COLUMN grading')
                legacy.execute("INSERT INTO calls(job_id,user_id,kind,model,seconds,input_tokens,output_tokens,created) VALUES(?,?,?,?,?,?,?,?)",(job['id'],self.user_id,'grading','deepseek-flash',2,200,300,time.time()))
                legacy.commit()
            with patch.object(app,'DB',target):
                app.init_db()
                app.init_db()
                migrated=app.fetch_job(job['id'])
                self.assertEqual(len(migrated['photos']),1)
                self.assertEqual(migrated['photos'][0]['id'],job['photos'][0]['id'])
                self.assertEqual(migrated['calls'][0]['input_tokens'],200)
                self.assertEqual(migrated['calls'][0]['output_tokens'],300)
                self.assertIsNone(migrated['calls'][0]['page'])
                self.assertIsNone(migrated['calls'][0]['pricing'])

    def submit_original(self,raw,name='original.jpg',page=1):
        return self.client.post('/api/jobs',data={'student_id':self.student,'day':'2026-10-04','submit_key':uuid.uuid4().hex,
            'material_map':json.dumps([{'file_index':0,'page':page}])},files=[('files',('child.jpg',jpeg(),'image/jpeg')),('original_files',(name,raw,'application/octet-stream'))])

    def test_original_image_and_crop_roles_private_access_and_usage(self):
        captured=[]
        value=copy.deepcopy(GRADING);value['questions'][0]['source_match']='matched'
        actual=app.model_call
        def answer(job_id,kind,prompt,images=(),photo_id=None):
            captured.append((kind,prompt,images))
            self.assertEqual(len(images),2)
            payload={'choices':[{'finish_reason':'stop','message':{'content':json.dumps(value)}}],'usage':{'prompt_tokens':2000,'completion_tokens':700}}
            with patch('app.httpx.Client') as remote:
                remote.return_value.__enter__.return_value.post.return_value=httpx.Response(200,json=payload)
                return actual(job_id,kind,prompt,images,photo_id=photo_id)
        with patch.object(app,'model_call',side_effect=answer):
            response=self.submit_original(jpeg())
            self.assertEqual(response.status_code,202,response.text)
            job=self.wait(response.json()['id'])
            self.assertEqual(job['status'],'review')
            self.assertEqual(job['result']['questions'][0]['status'],'incorrect')
            self.assertIn('学生在题干上约分不代表原题数字发生变化',captured[0][1])
            source=job['materials'][0]
            self.assertEqual(job['photos'][0]['material_id'],source['id'])
            self.assertEqual(job['calls'][0]['reference_count'],1)
            response=self.client.post(f"/api/jobs/{job['id']}/crop",json={'revision':job['revision'],'question_index':0,'photo_id':job['photos'][0]['id'],'x':.1,'y':.1,'width':.6,'height':.6})
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(captured[1][0],'crop')
            self.assertEqual(captured[1][2][1],captured[0][2][1])
            self.assertEqual(response.json()['calls'][-1]['reference_count'],1)
        image_url='/images/'+source['id']
        self.assertEqual(self.client.get(image_url).status_code,200)
        self.assertEqual(self.client.get(image_url+'?variant=original').content,jpeg())
        cookies=dict(self.client.cookies);self.client.cookies.clear()
        self.assertEqual(self.client.get(image_url).status_code,401)
        self.client.cookies.update(cookies)

    def test_unmatched_original_cannot_make_automatic_correct_judgment(self):
        for match in ['unmatched','uncertain','not_provided']:
            value=copy.deepcopy(GRADING);value['questions'][0].update(status='correct',source_match=match)
            with patch.object(app,'model_call',return_value=value):
                job=self.wait(self.submit_original(jpeg()).json()['id'])
            self.assertEqual(job['result']['questions'][0]['status'],'uncertain')
            self.assertIn('需核对',job['result']['questions'][0]['expected_answer'])

    def test_pdf_page_mapping_backup_restore_and_delete(self):
        raw=original_pdf()
        seen=[]
        def answer(job_id,kind,prompt,images=(),photo_id=None):
            seen.append(images)
            value=copy.deepcopy(GRADING);value['questions'][0]['source_match']='matched'
            return value
        with patch.object(app,'model_call',side_effect=answer):
            response=self.submit_original(raw,'original.pdf',page=2)
            self.assertEqual(response.status_code,202,response.text)
            job=self.wait(response.json()['id'])
        self.assertEqual(len(job['materials']),2)
        self.assertEqual(job['photos'][0]['material_id'],job['materials'][1]['id'])
        with Image.open(io.BytesIO(seen[0][1])) as image:
            r,g,b=image.getpixel((50,50));self.assertGreater(b,r)
        url='/images/'+job['materials'][1]['id']
        self.assertEqual(self.client.get(url+'?variant=original').content,raw)
        with tempfile.TemporaryDirectory() as temp:
            archive=Path(temp)/'with-original.zip'
            manage.backup(archive)
            target=Path(temp)/'restored';target.mkdir()
            with patch.object(app,'DATA',target),patch.object(app,'DB',target/'homework.sqlite3'):
                manage.restore(archive)
                self.assertEqual(app.fetch_job(job['id'])['materials'],job['materials'])
                with app.db() as c:
                    original=c.execute('SELECT original FROM materials WHERE id=?',(job['materials'][1]['id'],)).fetchone()[0]
                self.assertEqual((target/original).read_bytes(),raw)
        self.assertEqual(self.client.delete(f"/api/jobs/{job['id']}").status_code,200)
        self.assertEqual(self.client.get(url).status_code,404)
        self.assertFalse((app.DATA/'images'/job['id']).exists())

    def test_reject_bad_pdf_too_many_pages_and_wrong_mapping_without_call(self):
        before=set((app.DATA/'images').iterdir()) if (app.DATA/'images').exists() else set()
        with patch.object(app,'model_call') as model:
            for raw,name,page in [(b'%PDF-broken','bad.pdf',1),(original_pdf(11),'long.pdf',1),(jpeg(),'one.jpg',2),(b'not an image','fake.docx',1)]:
                response=self.submit_original(raw,name,page)
                self.assertEqual(response.status_code,422,response.text)
            self.assertFalse(model.called)
        self.assertEqual(before,set((app.DATA/'images').iterdir()))

    def test_manual_add_delete_questions_uses_review_and_invalidates_reply(self):
        job = self.review(self.ready_job())
        with app.db() as c:
            c.execute("UPDATE jobs SET status='confirmed',feedback='已确认回复',feedback_revision=revision WHERE id=?", (job['id'],))
        job = self.client.get(f"/api/jobs/{job['id']}").json()
        route = f"/api/jobs/{job['id']}"
        original_grading = None
        with app.db() as c:
            original_grading = c.execute("SELECT grading FROM photos WHERE job_id=?", (job['id'],)).fetchone()[0]
        added = copy.deepcopy(job['result'])
        question = copy.deepcopy(added['questions'][0])
        question.update(id=uuid.uuid4().hex, number='2', question='老师补录：4+5', student_answer='9', expected_answer='9', status='correct', explanation='人工核对结果正确', bbox=None, anchor_ids=[])
        added['questions'].append(question)
        with patch.object(app, 'model_call') as model:
            current = self.review(job, added, checked=False)
            self.assertEqual(len(current['result']['questions']), 2)
            self.assertEqual(current['revision'], job['revision'] + 1)
            self.assertEqual(current['status'], 'review')
            self.assertFalse(current['reviewed'])
            self.assertIsNone(current['feedback_revision'])
            self.assertEqual(current['feedback'], '已确认回复')
            self.assertEqual(self.client.post(route+'/confirm', json={'revision':current['revision']}).status_code, 422)
            removed = copy.deepcopy(current['result'])
            removed['questions'].pop(0)
            updated = self.review(current, removed)
            self.assertEqual([q['number'] for q in updated['result']['questions']], ['2'])
            self.assertEqual(updated['revision'], current['revision']+1)
            self.assertEqual(self.client.put(route+'/review', json={'revision':current['revision'],'result':removed}).status_code, 409)
            for result in [dict(removed, questions=[]), dict(removed, questions=[question]*201), dict(removed, questions=[dict(question,page=2)])]:
                self.assertEqual(self.client.put(route+'/review', json={'revision':updated['revision'],'result':result}).status_code, 422)
            with app.db() as c:
                c.execute("UPDATE jobs SET status='cropping' WHERE id=?", (job['id'],))
            self.assertEqual(self.client.put(route+'/review', json={'revision':updated['revision'],'result':removed}).status_code, 409)
            with app.db() as c:
                c.execute("UPDATE jobs SET status='review' WHERE id=?", (job['id'],))
                self.assertEqual(c.execute("SELECT grading FROM photos WHERE job_id=?", (job['id'],)).fetchone()[0], original_grading)
            model.assert_not_called()

    def test_paged_jobs_keep_old_pending_and_global_counts(self):
        today = app.datetime.now(app.timezone(app.timedelta(hours=8))).date().isoformat()
        prefix = uuid.uuid4().hex
        ids = [prefix + f'{i:03d}' for i in range(322)]
        with app.db() as c:
            c.executemany("INSERT INTO jobs(id,submit_key,user_id,student_id,day,status,created,updated) VALUES(?,?,?,?,?,?,?,?)", [
                (ident, uuid.uuid4().hex, self.user_id, self.student, today if i % 2 == 0 else '2026-09-01', 'review' if i==0 else 'failed' if i==1 else 'locating' if i==2 else 'confirmed', float(i), float(i))
                for i, ident in enumerate(ids)])
            expected_counts = {
                'pending':c.execute("SELECT COUNT(*) FROM jobs WHERE status<>'confirmed'").fetchone()[0],
                'needs_attention':c.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('review','failed')").fetchone()[0],
                'processing':c.execute("SELECT COUNT(*) FROM jobs WHERE status IN ("+','.join('?' for _ in app.BUSY)+')', sorted(app.BUSY)).fetchone()[0],
                'confirmed_today':c.execute("SELECT COUNT(*) FROM jobs WHERE status='confirmed' AND day=?", (today,)).fetchone()[0]}
        result = self.client.get('/api/jobs', params={'student_id':self.student}).json()
        self.assertEqual(result['total'], 3)
        self.assertEqual([item['id'] for item in result['items']], ids[2::-1])
        self.assertEqual((result['page'], result['page_size']), (1,30))
        self.assertEqual(result['counts'], expected_counts)
        all_ids = []
        for page in range(1,5):
            response = self.client.get('/api/jobs', params={'student_id':self.student,'filter':'all','page':page,'page_size':100})
            self.assertEqual(response.status_code,200,response.text)
            value = response.json()
            self.assertEqual(value['total'],322)
            self.assertEqual(value['counts'],expected_counts)
            all_ids.extend(item['id'] for item in value['items'])
        self.assertEqual(all_ids,list(reversed(ids)))
        self.assertEqual(len(set(all_ids)),322)
        filtered = self.client.get('/api/jobs',params={'student_id':self.student,'filter':'confirmed','day_from':today,'day_to':today}).json()
        self.assertEqual(filtered['total'],159)
        self.assertEqual(filtered['counts'],expected_counts)
        self.assertTrue(all(item['status']=='confirmed' and item['day']==today for item in filtered['items']))
        self.assertEqual(self.client.get('/api/jobs',params={'student_id':self.student,'page':1000}).json()['items'],[])
        for parameters in [{'page':0},{'page':10**40},{'page_size':0},{'page_size':101},{'filter':'unknown'},{'day_from':'invalid'},{'day_from':'2026-10-05','day_to':'2026-10-04'}]:
            self.assertEqual(self.client.get('/api/jobs',params=parameters).status_code,422)
        tied = [prefix+'tie-a',prefix+'tie-b']
        with app.db() as c:
            c.executemany("INSERT INTO jobs(id,submit_key,user_id,student_id,day,status,created,updated) VALUES(?,?,?,?,?,?,?,?)", [(ident,uuid.uuid4().hex,self.user_id,self.student,today,'confirmed',1000,1000) for ident in tied])
        self.assertEqual(self.client.get('/api/jobs',params={'student_id':self.student,'filter':'all','page_size':2}).json()['items'][0]['id'],tied[1])

    def test_job_asset_queries_use_job_page_indexes(self):
        with app.db() as c:
            for table, index in (("photos", "photos_job_page"), ("materials", "materials_job_page")):
                columns = [row["name"] for row in c.execute(f"PRAGMA index_info({index})")]
                self.assertEqual(columns, ["job_id", "page"])
                plan = " ".join(row["detail"] for row in c.execute(
                    f"EXPLAIN QUERY PLAN SELECT id FROM {table} WHERE job_id=? ORDER BY page", ("missing",)))
                self.assertIn(index, plan)

    def test_pdf_preview_bounded_private_and_without_persistent_data_or_model(self):
        raw = original_pdf()
        with app.db() as c:
            counts = [c.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ['jobs','materials','calls']]
        folder = app.DATA/'images'
        before = set(folder.rglob('*')) if folder.exists() else set()
        def preview(data=raw, **kwargs):
            return self.client.post('/api/materials/preview', files={'file':('original.pdf',data,'application/pdf')}, **kwargs)
        with patch.object(app,'model_call') as model:
            response = preview()
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(response.headers['cache-control'],'no-store')
            value = response.json()
            self.assertEqual(value['page_count'],2)
            self.assertEqual([p['page'] for p in value['pages']],[1,2])
            for i,page in enumerate(value['pages']):
                self.assertTrue(page['preview'].startswith('data:image/jpeg;base64,'))
                with Image.open(io.BytesIO(base64.b64decode(page['preview'].split(',',1)[1]))) as image:
                    self.assertLessEqual(max(image.size),600)
                    red,green,blue = image.getpixel((50,50))
                    self.assertGreater(red,blue) if i==0 else self.assertGreater(blue,red)
            self.assertEqual(preview(headers={'X-CSRF-Token':'wrong'}).status_code,403)
            cookies = dict(self.client.cookies)
            self.client.cookies.clear()
            self.assertEqual(preview().status_code,401)
            self.client.cookies.update(cookies)
            for invalid in [b'%PDF-broken',jpeg(),original_pdf(11)]:
                self.assertEqual(preview(invalid).status_code,422)
            with patch.object(app,'MAX_FILE',64):
                self.assertEqual(preview(b'x'*65).status_code,413)
                self.assertEqual(preview(headers={'Content-Length':str(64+64*1024+1)}).status_code,413)
            with patch.object(app.pdfium.PdfPage,'get_size',return_value=(float('inf'),100)):
                self.assertEqual(preview().status_code,422)
            model.assert_not_called()
        self.assertEqual(before,set(folder.rglob('*')) if folder.exists() else set())
        with app.db() as c:
            self.assertEqual(counts,[c.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ['jobs','materials','calls']])

    def test_submission_lookup_and_concurrent_duplicate_upload(self):
        key = uuid.uuid4().hex
        lookup = '/api/submissions/'+key
        response = self.client.get(lookup)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json(),{'id':None})
        self.assertEqual(response.headers['cache-control'],'no-store')
        cookies = dict(self.client.cookies)
        self.client.cookies.clear()
        self.assertEqual(self.client.get(lookup).status_code,401)
        self.client.cookies.update(cookies)
        self.assertEqual(self.client.get('/api/submissions/'+'x'*81).status_code,422)
        release, both_ready = threading.Event(), threading.Event()
        prepared, lock = [], threading.Lock()
        original = app.prepare_photo
        def prepare(*args):
            result = original(*args)
            with lock:
                prepared.append(result)
                if len(prepared)==2:both_ready.set()
            if not release.wait(10):raise RuntimeError('offline upload test timed out')
            return result
        with patch.object(app,'prepare_photo',side_effect=prepare),patch.object(app,'model_call',return_value=copy.deepcopy(GRADING)) as model:
            with ThreadPoolExecutor(max_workers=2) as pool:
                requests = [pool.submit(self.submit,key=key) for _ in range(2)]
                try:
                    self.assertTrue(both_ready.wait(10),'both uploads must pass the initial lookup before either is committed')
                    self.assertEqual(self.client.get(lookup).json(),{'id':None},'null means not registered yet, not that an upload cannot still finish')
                finally:
                    release.set()
                responses = [request.result(timeout=10) for request in requests]
            self.assertTrue(all(response.status_code==202 for response in responses),[response.text for response in responses])
            self.assertEqual(responses[0].json(),responses[1].json())
            job_id = responses[0].json()['id']
            self.wait(job_id)
            self.assertEqual(self.client.get(lookup).json(),{'id':job_id})
            self.assertEqual(model.call_count,1)
        with app.db() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM jobs WHERE submit_key=?',(key,)).fetchone()[0],1)
            self.assertEqual(c.execute('SELECT COUNT(*) FROM photos WHERE job_id=?',(job_id,)).fetchone()[0],1)
        self.assertEqual(sum((app.DATA/path[0]).exists() for path in prepared),1)

    def test_scoped_review_preserves_other_questions_and_cross_question_notes(self):
        job = self.ready_job(); route = f"/api/jobs/{job['id']}"
        result = copy.deepcopy(job['result']); first = result['questions'][0]
        result['questions'] = [dict(first, id=uuid.uuid4().hex, number=str(i), question=f'{i}+1', student_answer=str(i+1), status='correct') for i in range(1,5)]
        ids = [q['id'] for q in result['questions']]
        result['observations'] = [f'第{i}题有可见计算步骤' for i in range(1,5)]
        result['warnings'] = ['第1题字迹已核对', '笔迹可能属于第3题或第4题']
        result['warning_states'] = {text:'resolved' for text in result['warnings']}
        result['note_links'] = {'observation:'+text:{'scope':'questions','question_ids':[ids[i]],'checked':False} for i,text in enumerate(result['observations'])}
        result['note_links'].update({'warning:'+result['warnings'][0]:{'scope':'questions','question_ids':[ids[0]],'checked':False},
                                     'warning:'+result['warnings'][1]:{'scope':'questions','question_ids':ids[2:],'checked':False}})
        def save(current, value, questions=(), notes=()):
            return self.client.put(route+'/review',json={'revision':current['revision'],'result':value,'confirm_questions':list(questions),'confirm_notes':list(notes)})
        response=save(job,result,ids,result['note_links']);self.assertEqual(response.status_code,200,response.text);job=response.json()
        self.assertTrue(job['reviewed'])
        with patch.object(app,'model_call') as model:
            changed=copy.deepcopy(job['result']);changed['questions'][3]['student_answer']='9'
            # Client-side flags cannot preserve a verdict or clear pending records.
            changed['questions'][3]['reviewed']=True;changed['notes_pending']=False
            response=save(job,changed);self.assertEqual(response.status_code,200,response.text);current=response.json()
            self.assertEqual([q['reviewed'] for q in current['result']['questions']],[True,True,True,False])
            self.assertTrue(current['result']['questions'][3]['judgment_pending'])
            self.assertEqual(current['result']['questions'][:3],job['result']['questions'][:3])
            links=current['result']['note_links']
            self.assertTrue(links['observation:'+result['observations'][0]]['checked'])
            self.assertTrue(links['observation:'+result['observations'][3]]['checked'])
            self.assertTrue(links['observation:'+result['observations'][3]]['superseded'])
            self.assertFalse(links['warning:'+result['warnings'][1]]['checked'])
            self.assertEqual(current['result']['warning_states'][result['warnings'][0]],'resolved')
            self.assertNotIn(result['warnings'][1],current['result']['warning_states'])
            for suffix,method,extra in [('/feedback','POST',{}),('/feedback','PUT',{'feedback':'不能使用旧判定'}),('/confirm','POST',{})]:
                self.assertEqual(self.client.request(method,route+suffix,json={'revision':current['revision'],**extra}).status_code,422)
            model.assert_not_called()
        verdict={'status':'incorrect','expected_answer':'5','explanation':'离线模拟：9与5不同','knowledge_point':'加法'}
        with patch.object(app,'model_call',return_value=verdict) as model:
            response=self.client.post(route+'/judge-text',json={'revision':current['revision'],'question_index':3})
            self.assertEqual(response.status_code,200,response.text);current=response.json();self.assertEqual(model.call_count,1)
        self.assertEqual(current['result']['questions'][:3],job['result']['questions'][:3])
        self.assertFalse(current['result']['questions'][3]['reviewed'])
        self.assertFalse(current['result']['questions'][3]['judgment_pending'])
        self.assertEqual(current['result']['observations'],result['observations'],'text grading must not invent photo observations')
        related=[key for key,link in current['result']['note_links'].items() if ids[3] in link['question_ids']]
        response=save(current,current['result'],[ids[3]],related);self.assertEqual(response.status_code,200,response.text);current=response.json()
        self.assertTrue(current['reviewed']);self.assertFalse(current['result']['notes_pending'])
        self.assertIsNone(current['feedback_revision'])
        current=self.client.put(route+'/feedback',json={'revision':current['revision'],'feedback':'老师核对过的新回复'}).json()
        response=self.client.post(route+'/confirm',json={'revision':current['revision']});self.assertEqual(response.status_code,200);current=response.json()
        anchors=[{'id':1,'text':'1+1','bbox':{'x':.2,'y':.3,'width':.2,'height':.08}}]
        with patch.object(app,'photo_anchors',return_value=anchors),patch.object(app,'model_call',return_value={'locations':[{'question_index':0,'anchor_ids':[1]}]}):
            response=self.client.post(route+'/locate',json={'revision':current['revision'],'photo_id':current['photos'][0]['id']})
        self.assertEqual(response.status_code,200,response.text);current=response.json()
        self.assertEqual(current['status'],'confirmed');self.assertTrue(current['reviewed'])
        self.assertEqual(current['feedback_revision'],current['revision'])
        self.assertEqual(current['result']['warnings'],result['warnings'],'position notices must not become feedback evidence')
        self.assertTrue(all(link['checked'] for link in current['result']['note_links'].values()))
        self.assertIn('部分题目位置',current['error'])
        # Reordering uses IDs; deleted associations remain visible without forcing a new mapping.
        reordered=copy.deepcopy(current['result']);reordered['questions'].reverse()
        response=save(current,reordered);self.assertEqual(response.status_code,200,response.text);current=response.json()
        self.assertTrue(current['reviewed']);self.assertTrue(all(link['checked'] for link in current['result']['note_links'].values()))
        deleted=copy.deepcopy(current['result']);deleted['questions']=[q for q in deleted['questions'] if q['id']!=ids[2]]
        response=save(current,deleted);self.assertEqual(response.status_code,200,response.text);current=response.json()
        self.assertTrue(all(q['reviewed'] for q in current['result']['questions']))
        self.assertEqual(current['result']['note_links']['warning:'+result['warnings'][1]]['scope'],'unassigned')
        self.assertFalse(current['reviewed'])
        pending=[key for key,link in current['result']['note_links'].items() if not link['checked']]
        response=save(current,current['result'],notes=pending)
        self.assertEqual(response.status_code,200,response.text);current=response.json()
        self.assertIn(result['warnings'][1],app.feedback_basis(current['result'])['warnings'],'acknowledging an unknown association must not resolve it')
        reassigned=copy.deepcopy(current['result'])
        for key in pending:reassigned['note_links'][key].update(scope='questions',question_ids=[ids[3]])
        response=save(current,reassigned,notes=pending);self.assertEqual(response.status_code,200,response.text);current=response.json()
        self.assertTrue(current['reviewed'])
        bad=copy.deepcopy(current['result']);bad['questions'][1]['id']=bad['questions'][0]['id']
        self.assertEqual(save(current,bad).status_code,422)
        bad=copy.deepcopy(current['result']);bad['note_links'][pending[0]]['question_ids']=['nonexistent']
        self.assertEqual(save(current,bad).status_code,422)
        self.assertEqual(save(current,current['result'],['nonexistent']).status_code,422)

    def test_legacy_review_ids_stable_without_get_mutations_and_model_note_links(self):
        job=self.ready_job(); route=f"/api/jobs/{job['id']}"
        with app.db() as c:c.execute("UPDATE jobs SET result=?,reviewed=1,feedback_revision=revision WHERE id=?",(json.dumps(GRADING),job['id']))
        first=self.client.get(route).json();second=self.client.get(route).json()
        self.assertEqual(first['result'],second['result']);self.assertEqual(first['revision'],second['revision'])
        self.assertTrue(first['result']['questions'][0]['reviewed']);self.assertTrue(first['reviewed'])
        with app.db() as c:self.assertEqual(json.loads(c.execute('SELECT result FROM jobs WHERE id=?',(job['id'],)).fetchone()[0]),GRADING)
        inconsistent=copy.deepcopy(first['result']);inconsistent['questions'][0]['reviewed']=False
        with app.db() as c:c.execute('UPDATE jobs SET result=? WHERE id=?',(json.dumps(inconsistent),job['id']))
        self.assertEqual(self.client.post(route+'/feedback',json={'revision':first['revision']}).status_code,422,'global review cannot override pending question state')
        value=copy.deepcopy(GRADING);value['observations']=['可见步骤'];value['questions'][0].update(observation_indices=[0],warning_indices=[0],reviewed=True,judgment_pending=True)
        parsed=app.validate_grading(value,1)
        q=parsed['questions'][0];self.assertFalse(q['reviewed']);self.assertFalse(q['judgment_pending'])
        self.assertEqual(parsed['note_links']['observation:可见步骤']['question_ids'],[q['id']])
        self.assertEqual(parsed['note_links']['warning:'+value['warnings'][0]]['scope'],'questions')
        self.assertFalse(parsed['note_links']['warning:'+value['warnings'][0]]['checked'])

    def test_combined_confirmation_resolves_only_explicit_related_issues(self):
        job=self.ready_job();route=f"/api/jobs/{job['id']}"
        result=copy.deepcopy(job['result']);q=result['questions'][0];q.update(status='uncertain',student_answer='看不清')
        q2=dict(q,id=uuid.uuid4().hex,number='2',question='2+3',student_answer='5',status='correct')
        result['questions'].append(q2);ids=[q['id'],q2['id']]
        result.update(observations=['有涂改，最终答案无法确认'],warnings=['本题答案无法确认','另一页可能缺失'])
        obs='observation:'+result['observations'][0];issue='warning:'+result['warnings'][0];other='warning:'+result['warnings'][1]
        result['note_links']={obs:{'scope':'questions','question_ids':[ids[0]],'checked':False},issue:{'scope':'questions','question_ids':[ids[0]],'checked':False},other:{'scope':'unassigned','question_ids':[],'checked':False}}
        job=self.review(job,result)
        changed=copy.deepcopy(job['result']);changed['questions'][0].update(question='3/8÷9/13',student_answer='104/3')
        response=self.client.put(route+'/review',json={'revision':job['revision'],'result':changed,'confirm_questions':[]})
        self.assertEqual(response.status_code,200,response.text);job=response.json()
        verdict={'status':'incorrect','expected_answer':'13/24','explanation':'离线固定样例：最终结果不相等','knowledge_point':'分数除法'}
        with patch.object(app,'model_call',return_value=verdict):
            job=self.client.post(route+'/judge-text',json={'revision':job['revision'],'question_index':0}).json()
        self.assertTrue(job['result']['questions'][1]['reviewed'])
        self.assertTrue(job['result']['note_links'][obs]['superseded'])
        self.assertTrue(job['result']['note_links'][other]['checked'])
        def save(value,confirmations=(),resolved=(),notes=()):
            return self.client.put(route+'/review',json={'revision':job['revision'],'result':value,'confirm_questions':list(confirmations),'confirm_notes':list(notes),'resolve_notes':list(resolved)})
        self.assertEqual(save(job['result'],[ids[0]],[other]).status_code,422,'unknown scope cannot be guessed resolved')
        uncertain=copy.deepcopy(job['result']);uncertain['questions'][0]['status']='uncertain'
        self.assertEqual(save(uncertain,[ids[0]],[issue]).status_code,422)
        cross=copy.deepcopy(job['result']);cross['note_links'][issue]['question_ids']=ids;cross['questions'][1]['student_answer']='7'
        self.assertEqual(save(cross,[ids[0]],[issue]).status_code,422,'cross-question issue requires all related questions confirmed')
        photo=copy.deepcopy(job['result']);photo['warning_states'][result['warnings'][0]]='needs_photo'
        self.assertEqual(save(photo,[ids[0]],[issue]).status_code,422)
        response=save(job['result'],[ids[0]],[issue],[issue]);self.assertEqual(response.status_code,200,response.text);job=response.json()
        self.assertTrue(job['reviewed']);self.assertEqual(job['result']['warning_states'][result['warnings'][0]],'resolved')
        basis=app.feedback_basis(job['result'])
        self.assertEqual(basis['observations'],[]);self.assertEqual(basis['warnings'],[result['warnings'][1]])
        self.assertEqual(job['result']['observations'],result['observations'],'retain original record for inspection')
        # Editing explanatory text does not reopen recognition records or require another API call.
        changed=copy.deepcopy(job['result']);changed['questions'][0]['knowledge_point']='分数运算'
        response=save(changed);self.assertEqual(response.status_code,200,response.text);job=response.json()
        self.assertEqual(job['result']['warning_states'][result['warnings'][0]],'resolved')
        self.assertFalse(job['result']['notes_pending'])
        response=save(job['result'],[ids[0]]);self.assertEqual(response.status_code,200,response.text);job=response.json()
        prompts=[]
        def feedback(*args,**kwargs):
            prompts.append(args[2]);return {'feedback':'其余题完成得不错，这题注意除以分数要乘倒数。','history_evidence':[]}
        with patch.object(app,'model_call',side_effect=feedback) as model:
            response=self.client.post(route+'/feedback',json={'revision':job['revision']});self.assertEqual(response.status_code,202)
            job=self.wait(job['id']);self.assertEqual(model.call_count,1)
        self.assertNotIn('最终答案无法确认',prompts[0]);self.assertNotIn('本题答案无法确认',prompts[0]);self.assertIn('另一页可能缺失',prompts[0])
        # A teacher can explicitly restore a visible observation without rejudging any question.
        restored=copy.deepcopy(job['result']);restored['observations']=['本题有涂改'];restored['note_links']={'observation:本题有涂改':{'scope':'questions','question_ids':[ids[0]],'checked':False,'superseded':False},**{k:v for k,v in restored['note_links'].items() if k!=obs}}
        response=save(restored,notes=['observation:本题有涂改']);self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(app.feedback_basis(response.json()['result'])['observations'],['本题有涂改'])

    def test_model_note_links_survive_page_merge_and_localization_notice(self):
        value=copy.deepcopy(GRADING);value['observations']=['本题可见计算步骤'];value['warnings']=['本题的印刷符号需核对']
        value['questions'][0].update(observation_indices=[0],warning_indices=[0])
        with patch.object(app,'model_call',side_effect=lambda *args,**kwargs:copy.deepcopy(value)) as model:
            response=self.client.post('/api/jobs',data={'student_id':self.student,'day':'2026-10-03','submit_key':uuid.uuid4().hex},
                                      files=[('files',('page1.jpg',jpeg(),'image/jpeg')),('files',('page2.jpg',jpeg(),'image/jpeg'))])
            self.assertEqual(response.status_code,202,response.text);job=self.wait(response.json()['id'])
            self.assertEqual(model.call_count,2)
        self.assertEqual(job['status'],'review');result=job['result']
        ids=[q['id'] for q in result['questions']]
        self.assertEqual(len(set(ids)),2);self.assertEqual([q['page'] for q in result['questions']],[1,2])
        for key in ['observation:'+value['observations'][0],'warning:'+value['warnings'][0]]:
            self.assertEqual(result['note_links'][key]['scope'],'questions')
            self.assertEqual(result['note_links'][key]['question_ids'],ids)
        system_notes=[n for n in result['image_notes'] if '文字区域' in n]
        self.assertEqual(len(system_notes),2)
        self.assertTrue(all('warning:'+text not in result['note_links'] for text in system_notes))
        self.assertTrue(all(text not in app.feedback_basis(result)['warnings'] for text in system_notes))

    def test_notes_reconciliation_and_feedback_evidence(self):
        job = self.ready_job();route = f"/api/jobs/{job['id']}"
        result = copy.deepcopy(job['result'])
        result['observations'] = ['第1页：可见两行计算步骤。']
        result['warnings'] = ['旧作答无法辨认', '第1页：另一题需补拍']
        job = self.review(job, result)
        verdict = {'status':'correct','expected_answer':'6','explanation':'离线模拟判定正确','knowledge_point':'加法'}
        with patch.object(app, 'model_call', return_value=verdict):
            response = self.client.post(route+'/judge-text', json={'revision':job['revision'],'question_index':0})
        self.assertEqual(response.status_code,200,response.text);job=response.json()
        self.assertFalse(job['result']['notes_pending'],'unrelated acknowledged notes stay acknowledged')
        self.assertEqual(job['result']['notes_changes'],[])
        self.assertEqual(job['result']['observations'],result['observations'])
        self.assertEqual(job['result']['warnings'],result['warnings'])
        # A client cannot clear server-side pending notes just by sending false.
        unchecked=copy.deepcopy(job['result']);unchecked['notes_pending']=False;unchecked['notes_changes']=[]
        body={'revision':job['revision'],'result':unchecked,'reviewed':True}
        self.assertEqual(self.client.put(route+'/review',json=body).status_code,422)
        body['reviewed']=False
        saved=self.client.put(route+'/review',json=body);self.assertEqual(saved.status_code,200,saved.text)
        job=saved.json();self.assertFalse(job['result']['notes_pending'])
        for suffix,method,extra in [('/feedback','POST',{}),('/feedback','PUT',{'feedback':'旧回复'}),('/confirm','POST',{})]:
            self.assertEqual(self.client.request(method,route+suffix,json={'revision':job['revision'],**extra}).status_code,422)
        result=copy.deepcopy(job['result'])
        result['warning_states']={result['warnings'][0]:'resolved',result['warnings'][1]:'needs_photo'}
        response=self.client.put(route+'/review',json={'revision':job['revision'],'result':result,'reviewed':True,'notes_checked':True})
        self.assertEqual(response.status_code,200,response.text);job=response.json()
        self.assertFalse(job['result']['notes_pending']);self.assertEqual(job['result']['notes_changes'],[])
        self.assertEqual(job['result']['warnings'],result['warnings'],'resolved notes must remain available for review')
        prompts=[]
        def feedback(*args,**kwargs):
            prompts.append(args[2]);return {'feedback':'模拟回复，请补拍另一题。','history_evidence':[]}
        with patch.object(app,'model_call',side_effect=feedback):
            self.assertEqual(self.client.post(route+'/feedback',json={'revision':job['revision']}).status_code,202)
            job=self.wait(job['id'])
        self.assertEqual(len(prompts),1)
        self.assertNotIn('旧作答无法辨认',prompts[0]);self.assertIn('另一题需补拍',prompts[0])
        self.assertIn('老师确认需补图',prompts[0])
        self.assertNotIn('两行计算步骤',prompts[0],'unassigned photo observations may include stale interpretations after correction')
        self.assertNotIn('notes_pending',prompts[0])
        self.assertEqual(self.client.post(route+'/confirm',json={'revision':job['revision']}).status_code,200)
        current=self.review(self.ready_job())
        with patch.object(app,'model_call',side_effect=feedback):
            self.assertEqual(self.client.post(f"/api/jobs/{current['id']}/feedback",json={'revision':current['revision']}).status_code,202)
            self.wait(current['id'])
        self.assertNotIn('旧作答无法辨认',prompts[-1],'resolved historical notes must also be excluded')
        # An unassigned, explicitly handled issue is not guessed to belong to every edit.
        job=self.client.get(route).json();result=copy.deepcopy(job['result'])
        result['questions'][0]['student_answer']='7'
        response=self.client.put(route+'/review',json={'revision':job['revision'],'result':result,'reviewed':False})
        self.assertEqual(response.status_code,200,response.text);job=response.json()
        self.assertFalse(job['result']['notes_pending']);self.assertEqual(job['result']['warning_states'],result['warning_states'])
        # Old stored JSON without the new fields remains readable and reviewable.
        legacy={key:value for key,value in GRADING.items()}
        with app.db() as c:c.execute('UPDATE jobs SET result=?,reviewed=0 WHERE id=?',(json.dumps(legacy),job['id']))
        job=self.client.get(route).json();job=self.review(job)
        self.assertFalse(job['result']['notes_pending'])
        invalid=copy.deepcopy(job['result']);invalid['warning_states']={'unknown note':'resolved'}
        self.assertEqual(self.client.put(route+'/review',json={'revision':job['revision'],'result':invalid}).status_code,422)
        invalid['warning_states']={invalid['warnings'][0]:'invented'}
        self.assertEqual(self.client.put(route+'/review',json={'revision':job['revision'],'result':invalid}).status_code,422)
        model_result=copy.deepcopy(job['result']);model_result['warning_states']={model_result['warnings'][0]:'resolved'}
        model_result['notes_pending']=True;model_result['notes_changes']=['模型不得代替老师确认']
        validated=app.validate_grading(model_result,1)
        self.assertEqual(validated['warning_states'],{});self.assertFalse(validated['notes_pending'])
        self.assertEqual(validated['notes_changes'],[])

    def test_exception_only_flow_and_image_notes_never_enter_parent_feedback(self):
        value = copy.deepcopy(GRADING)
        value['questions'][0].update(status='correct', student_answer='5')
        value['questions'].append(dict(value['questions'][0], number='2', question='比大小：8/9 ○ 8/11',
                                       student_answer='看不清', status='uncertain', warning_indices=[0]))
        value['warnings']=['第2题符号无法辨认']
        value['image_notes']=['页面下部透印，未影响作答识别']
        with patch.object(app, 'model_call', return_value=value):
            response = self.submit()
            job = self.wait(response.json()['id'])
        self.assertFalse(any(q['reviewed'] for q in job['result']['questions']))
        self.assertEqual(job['result']['warnings'], value['warnings'])
        self.assertEqual(job['result']['image_notes'][0], value['image_notes'][0])
        result = copy.deepcopy(job['result'])
        result['questions'][1]['student_answer']='>'
        job = self.review(job, result, checked=False)
        verdict={'status':'correct','expected_answer':'>','explanation':'同分子分数，分母小的分数大。','knowledge_point':'分数比较'}
        route = f"/api/jobs/{job['id']}"
        with patch.object(app, 'model_call', return_value=verdict):
            response=self.client.post(route+'/judge-text',json={'revision':job['revision'],'question_index':1})
        self.assertEqual(response.status_code, 200, response.text)
        job=response.json()
        self.assertFalse(any(q['reviewed'] for q in job['result']['questions']), 'no per-question confirmation is required before the final adoption')
        response=self.client.put(route+'/review',json={'revision':job['revision'],'result':job['result'],
            'confirm_questions':[q['id'] for q in job['result']['questions']],
            'confirm_notes':list(job['result']['note_links']), 'resolve_notes':['warning:'+value['warnings'][0]]})
        self.assertEqual(response.status_code, 200, response.text)
        job=response.json();self.assertTrue(job['reviewed'])
        def feedback(job_id,kind,prompt,images=()):
            self.assertEqual(kind,'feedback')
            current=json.loads(prompt.split('\n')[-1])['current']
            self.assertNotIn('image_notes', current)
            self.assertNotIn(value['image_notes'][0], prompt)
            self.assertEqual(current['warnings'], [])
            return {'feedback':'这次计算结果都对，继续保持。','history_evidence':[]}
        with patch.object(app, 'model_call', side_effect=feedback) as model:
            self.assertEqual(self.client.post(route+'/feedback',json={'revision':job['revision']}).status_code,202)
            job=self.wait(job['id']);self.assertEqual(model.call_count,1)
        self.assertEqual(job['status'],'review')
        self.assertEqual(job['feedback'], '这次计算结果都对，继续保持。')
        old=copy.deepcopy(job['result'])
        notice='第1页：部分题目未关联到可靠文字区域，请手动标记位置。'
        old['warnings'].extend([notice,'可能漏了一题'])
        old['note_links']['warning:'+notice]={'scope':'unassigned','question_ids':[],'checked':False}
        app.normalize_review(old,job['id'])
        self.assertIn(notice, old['image_notes'])
        self.assertNotIn(notice, old['warnings'])
        self.assertIn('可能漏了一题', old['warnings'])
        self.assertTrue(old['notes_pending'], 'real coverage doubts must not be silently resolved')

    def test_comparison_symbol_can_be_saved_and_rejudged_with_current_review_fields(self):
        job = self.ready_job()
        result = copy.deepcopy(job['result'])
        result['questions'][0].update(question='比大小：8/9 ○ 8/11', student_answer='>',
                                      expected_answer='> （8/9 > 8/11）', status='uncertain')
        result['note_links']['warning:' + result['warnings'][0]]['superseded'] = False
        with patch.object(app, 'model_call') as model:
            job = self.review(job, result, checked=False)
            model.assert_not_called()
        self.assertEqual(job['result']['questions'][0]['student_answer'], '>')
        verdict = {'status':'correct','expected_answer':'>',
                   'explanation':'分子相同，分母越小分数越大。','knowledge_point':'分数大小比较'}
        with patch.object(app, 'model_call', return_value=verdict) as model:
            response = self.client.post(f"/api/jobs/{job['id']}/judge-text",
                                        json={'revision':job['revision'],'question_index':0})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(model.call_count, 1)
        self.assertEqual(response.json()['result']['questions'][0]['status'], 'correct')
        self.assertEqual(response.json()['result']['questions'][0]['student_answer'], '>')

    def test_text_judgment_uses_saved_text_preserves_fields_and_records_usage(self):
        job = self.ready_job()
        result = copy.deepcopy(job['result'])
        q = result['questions'][0]
        q.update(question='3/8÷9/13', student_answer='104/3', expected_answer='旧答案不可作为依据',
                 explanation='旧说明不可作为依据', status='uncertain', bbox={'x':.1,'y':.2,'width':.5,'height':.2},
                 bbox_source='teacher', anchor_ids=[1], source_match='unmatched')
        result['questions'].append(dict(q, id=uuid.uuid4().hex, number='2', question='2+3', student_answer='5', status='correct'))
        job = self.review(job, result)
        route = f"/api/jobs/{job['id']}"
        job = self.client.put(route+'/feedback',json={'revision':job['revision'],'feedback':'已核对的旧回复'}).json()
        job = self.client.post(route+'/confirm',json={'revision':job['revision']}).json()
        verdict = {'status':'incorrect','expected_answer':'13/24','explanation':'模拟判题：乘以除数的倒数；104/3与13/24不等价。','knowledge_point':'分数除法'}
        payload = {'choices':[{'finish_reason':'stop','message':{'content':json.dumps(verdict)}}],
                   'usage':{'prompt_tokens':100,'completion_tokens':50,'prompt_cache_hit_tokens':0}}
        with patch('app.httpx.Client') as client:
            post = client.return_value.__enter__.return_value.post
            post.return_value = httpx.Response(200,json=payload)
            response = self.client.post(route+'/judge-text',json={'revision':job['revision'],'question_index':0})
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(post.call_count,1)
            content = post.call_args.kwargs['json']['messages'][0]['content']
            self.assertEqual(len(content),1,'text judgment must not send a photo or original material')
            self.assertEqual(content[0]['type'],'text')
            text = content[0]['text']
            self.assertIn('带分数8又1/3',text)
            self.assertIn('(8+1/3)',text)
            self.assertIn('3/8÷9/13',text);self.assertIn('104/3',text)
            self.assertNotIn('旧答案不可作为依据',text);self.assertNotIn('旧说明不可作为依据',text)
        updated = response.json()
        self.assertEqual(updated['revision'],job['revision']+1)
        self.assertEqual(updated['status'],'review');self.assertFalse(updated['reviewed'])
        self.assertIsNone(updated['feedback_revision']);self.assertEqual(updated['feedback'],job['feedback'])
        current = updated['result']['questions'][0]
        for field in verdict:self.assertEqual(current[field],verdict[field])
        self.assertFalse(current['reviewed'])
        for field in set(job['result']['questions'][0])-set(verdict)-{'reviewed'}:
            self.assertEqual(current[field],job['result']['questions'][0][field],field)
        self.assertEqual(updated['result']['questions'][1],job['result']['questions'][1])
        self.assertEqual(updated['result']['observations'],job['result']['observations'])
        self.assertEqual(updated['result']['warnings'],job['result']['warnings'])
        call = updated['calls'][-1]
        self.assertEqual((call['kind'],call['page'],call['reference_count']),('text_judgment',1,0))
        self.assertEqual((call['input_tokens'],call['output_tokens']),(100,50))
        self.assertIsNotNone(call['pricing'])
        self.assertEqual(self.client.post(route+'/confirm',json={'revision':updated['revision']}).status_code,422)
        payload['choices'][0]['message']['content'] = json.dumps({'status':'correct'})
        with patch('app.httpx.Client') as client:
            client.return_value.__enter__.return_value.post.return_value = httpx.Response(200,json=payload)
            bad = self.client.post(route+'/judge-text',json={'revision':updated['revision'],'question_index':0})
            self.assertEqual(bad.status_code,502)
        retained = app.fetch_job(job['id'])
        self.assertEqual(retained['result'],updated['result']);self.assertEqual(retained['revision'],updated['revision'])
        self.assertEqual(len(retained['calls']),len(updated['calls'])+1,'invalid verdict still has billable usage recorded')
        self.assertEqual(retained['calls'][-1]['kind'],'text_judgment')

    def test_mixed_number_judgment_is_explicit_without_rewriting_saved_text(self):
        job = self.ready_job()
        result = copy.deepcopy(job['result'])
        result['questions'][0].update(question=r'\frac{1}{6}\div8又1/3', student_answer='1/50', status='uncertain')
        job = self.review(job, result)
        verdict = {'status':'correct','expected_answer':'1/50','explanation':'模拟结果，仅验证文字传递。','knowledge_point':'带分数'}
        with patch.object(app, 'model_call', return_value=verdict) as model:
            response = self.client.post(f"/api/jobs/{job['id']}/judge-text", json={'revision':job['revision'],'question_index':0})
            self.assertEqual(response.status_code, 200, response.text)
            sent = json.loads(model.call_args.args[2].split('老师核对的文字：')[1])
            self.assertEqual(sent['question'], r'\frac{1}{6}\div(8+1/3)')
            self.assertEqual(sent['student_answer'], '1/50')
        self.assertEqual(response.json()['result']['questions'][0]['question'], result['questions'][0]['question'])
        job=response.json()
        result=copy.deepcopy(job['result'])
        result['questions'][0]['student_answer']=r'\frac{1}{\placeholder{}}'
        job=self.review(job,result,checked=False)
        with patch.object(app,'model_call') as model:
            response=self.client.post(f"/api/jobs/{job['id']}/judge-text",json={'revision':job['revision'],'question_index':0})
            self.assertEqual(response.status_code,422)
            model.assert_not_called()
        self.assertEqual(self.client.get(f"/api/jobs/{job['id']}").json()['status'],'review')

    def test_text_judgment_guards_failure_uncertainty_and_restart(self):
        job = self.review(self.ready_job());route = f"/api/jobs/{job['id']}"
        job = self.client.put(route+'/feedback',json={'revision':job['revision'],'feedback':'已归档的旧回复'}).json()
        job = self.client.post(route+'/confirm',json={'revision':job['revision']}).json()
        body = {'revision':job['revision'],'question_index':0}
        with patch.object(app,'model_call') as model:
            for request,expected in [(dict(body,revision=-1),409),(dict(body,question_index=-1),422),(dict(body,question_index=99),422)]:
                self.assertEqual(self.client.post(route+'/judge-text',json=request).status_code,expected)
            csrf = self.client.headers.pop('X-CSRF-Token')
            self.assertEqual(self.client.post(route+'/judge-text',json=body).status_code,403)
            self.client.headers['X-CSRF-Token'] = csrf
            cookies = dict(self.client.cookies);self.client.cookies.clear()
            self.assertEqual(self.client.post(route+'/judge-text',json=body).status_code,401)
            self.client.cookies.update(cookies)
            with patch.dict(os.environ,{'DEEPSEEK_API_KEY':''}):
                self.assertEqual(self.client.post(route+'/judge-text',json=body).status_code,503)
            model.assert_not_called()
        for value in [{'status':'correct'}, {'status':'wrong','expected_answer':'5','explanation':'bad','knowledge_point':'加法'}]:
            with patch.object(app,'model_call',return_value=value) as model:
                self.assertEqual(self.client.post(route+'/judge-text',json=body).status_code,502)
                self.assertEqual(model.call_count,1)
            current = app.fetch_job(job['id'])
            self.assertEqual(current['result'],job['result']);self.assertEqual(current['revision'],job['revision'])
            self.assertEqual(current['status'],job['status'])
        with patch.object(app,'model_call',side_effect=ValueError('API 余额不足')) as model:
            response = self.client.post(route+'/judge-text',json=body)
            self.assertEqual(response.status_code,502);self.assertIn('余额不足',response.json()['detail']);self.assertEqual(model.call_count,1)
        result = copy.deepcopy(job['result']);result['questions'][0].update(question='如图，求阴影面积',student_answer='8')
        job = self.review(job,result)
        uncertain = {'status':'uncertain','expected_answer':'无法确定','explanation':'需要补充图形与尺寸条件。','knowledge_point':'面积'}
        with patch.object(app,'model_call',return_value=uncertain):
            response = self.client.post(route+'/judge-text',json={'revision':job['revision'],'question_index':0})
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(response.json()['result']['questions'][0]['status'],'uncertain')
        result = copy.deepcopy(response.json()['result']);result['questions'][0]['question']=' '
        job = self.review(response.json(),result)
        with patch.object(app,'model_call') as model:
            self.assertEqual(self.client.post(route+'/judge-text',json={'revision':job['revision'],'question_index':0}).status_code,422)
            model.assert_not_called()
        with app.db() as c:c.execute("UPDATE jobs SET status='judging',location_previous_status='confirmed' WHERE id=?",(job['id'],))
        app.recover_interrupted_jobs();recovered = app.fetch_job(job['id'])
        self.assertEqual(recovered['status'],'confirmed');self.assertEqual(recovered['result'],job['result'])
        self.assertIn('中断',recovered['error'])

    def test_text_judgment_blocks_concurrent_paid_calls_and_mutations(self):
        job = self.ready_job();history = self.ready_job();route = f"/api/jobs/{job['id']}"
        started,release = threading.Event(),threading.Event()
        def answer(*args,**kwargs):
            started.set()
            if not release.wait(10):raise ValueError('offline test deadline')
            return {'status':'incorrect','expected_answer':'5','explanation':'模拟判题。','knowledge_point':'加法'}
        with patch.object(app,'model_call',side_effect=answer) as model:
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.client.post,route+'/judge-text',json={'revision':job['revision'],'question_index':0})
                try:
                    self.assertTrue(started.wait(10))
                    self.assertEqual(self.client.post(route+'/judge-text',json={'revision':job['revision'],'question_index':0}).status_code,409)
                    self.assertEqual(self.client.put(route+'/review',json={'revision':job['revision'],'result':job['result'],'reviewed':True}).status_code,409)
                    self.assertEqual(self.client.delete(route).status_code,409)
                    self.assertEqual(self.client.delete(f"/api/jobs/{history['id']}").status_code,409)
                    self.assertEqual(self.client.delete(f"/api/students/{self.student}").status_code,409)
                    self.assertGreaterEqual(self.client.get('/api/jobs').json()['counts']['processing'],1)
                finally:release.set()
                self.assertEqual(pending.result(timeout=10).status_code,200)
            self.assertEqual(model.call_count,1)

    def test_generated_photos_preprocess_without_changes(self):
        """Public regression fixtures must never depend on actual pupils' work."""
        with tempfile.TemporaryDirectory(dir=app.DATA) as folder:
            for width, height, color in ((100, 180, "white"), (800, 1200, "blue"), (1200, 800, "red")):
                buffer = io.BytesIO()
                Image.new("RGB", (width, height), color).save(buffer, "JPEG")
                raw = buffer.getvalue()
                digest = hashlib.sha256(raw).hexdigest()
                original, full, thumb = app.prepare_photo(raw, Path(folder), uuid.uuid4().hex)
                self.assertEqual(hashlib.sha256((app.DATA / original).read_bytes()).hexdigest(), digest)
                with Image.open(app.DATA / full) as image:
                    self.assertLessEqual(max(image.size), 3200)
                with Image.open(app.DATA / thumb) as image:
                    self.assertLessEqual(max(image.size), 440)

    def test_backup_and_restore_integrity(self):
        job=self.ready_job()
        with tempfile.TemporaryDirectory() as temp:
            archive=Path(temp)/"backup.zip"
            manage.backup(archive)
            target=Path(temp)/"restored";target.mkdir()
            with patch.object(app,"DATA",target),patch.object(app,"DB",target/"homework.sqlite3"):
                manage.restore(archive)
                self.assertEqual(app.fetch_job(job["id"])["photos"],job["photos"])
                with app.db() as c:
                    self.assertEqual(c.execute("SELECT COUNT(*) FROM sessions").fetchone()[0],0)


if __name__ == "__main__":
    unittest.main()
