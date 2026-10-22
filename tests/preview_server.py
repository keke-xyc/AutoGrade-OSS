"""Local-only, ephemeral UI test server. Never deploy this file."""
import io
import json
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
TEMP = tempfile.TemporaryDirectory()
os.environ.update(DATA_DIR=TEMP.name, COOKIE_SECURE="false", PUBLIC_ORIGIN="", DEEPSEEK_API_KEY="offline-preview-placeholder", AUTOGRADE_OFFLINE_DEMO="1")
import app
import uvicorn

os.environ["ADMIN_PASSWORD_HASH"] = app.hash_password("offline-preview-only")
app.init_db()
RESULT = {"questions": [
    {"page":1,"number":"界面测试题 1","question":"此题为模拟数据，用于验证移动端编辑与保存。","student_answer":"模拟作答","status":"uncertain","expected_answer":"需老师确认","explanation":"未调用模型；不能据此评价照片中的真实作业。","knowledge_point":"界面测试"},
    {"page":1,"number":"界面测试题 2","question":"此题为模拟数据，用于验证判定修改。","student_answer":"6","status":"incorrect","expected_answer":"5","explanation":"模拟的错误判定，仅测试交互。","knowledge_point":"界面测试"}],"observations":[],"warnings":["离线模拟结果：不是照片的真实批改"]}
RESULT['questions'][0]['bbox']={'x':.08,'y':.13,'width':.84,'height':.15}
RESULT['questions'][1]['bbox']={'x':.08,'y':.35,'width':.84,'height':.15}
RESULT['observations']=['离线模拟旧观察：有涂改，最终作答看不清（仅测试记录处理）。']
RESULT['image_notes']=['离线模拟照片说明：页面下部有透印，未影响作答识别；仅测试留档。']
RESULT['warnings'].append('离线模拟疑问：第1题最终作答无法辨认。')
RESULT['questions'][0].update(observation_indices=[0],warning_indices=[1])
RESULT=app.validate_grading(RESULT,1)


def simulate(job_id, kind, prompt, images=(), photo_id=None):
    time.sleep(float(os.getenv("AUTOGRADE_DEMO_DELAY", ".5")) if kind == "grading" else .5)
    if kind == "text_judgment":
        text = json.loads(prompt.split('老师核对的文字：',1)[1])
        if text['question'].replace(' ','') == '3/8÷9/13' and text['student_answer'].strip() == '104/3':
            return {'status':'incorrect','expected_answer':'13/24','explanation':'离线演示固定样例：3/8×13/9=13/24，与104/3不等价。未调用模型。','knowledge_point':'分数除法'}
        return {'status':'uncertain','expected_answer':'离线演示不计算其他题目','explanation':'此为模拟响应，仅验证交互，不是真实判题。','knowledge_point':'界面测试'}
    if kind == "feedback":
        return {"feedback":"这是一段用于测试复制与归档的模拟回复。真实家长评语需要先配置 API，再依据老师复核过的真实作业生成。","history_evidence":[]}
    value = json.loads(json.dumps(RESULT))
    for q in value['questions']:
        q['source_match']='matched' if len(images)>1 else 'not_provided'
    if kind == "crop":
        value["questions"] = value["questions"][:1]
    return value


app.model_call = simulate
student, job_id, photo_id, material_id = [uuid.uuid4().hex for _ in range(4)]
folder = app.DATA / "images" / job_id
folder.mkdir(parents=True)
def synthetic_photo():
    """Generate a fictional worksheet for the offline UI demo; no private photos."""
    canvas = Image.new("RGB", (900, 1200), "white")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((32, 32, 868, 1168), outline="#aaaaaa", width=3)
    draw.text((72, 85), "SYNTHETIC WORKSHEET - OFFLINE DEMO ONLY", fill="black")
    draw.text((88, 170), "1. 3/8 / 9/13 = ?", fill="black")
    draw.text((88, 395), "2. 2 + 3 = 6", fill="black")
    draw.text((72, 650), "This is generated test data, not student homework.", fill="black")
    output = io.BytesIO()
    canvas.save(output, format="JPEG")
    return output.getvalue()


paths = app.prepare_photo(synthetic_photo(), folder, photo_id)
with app.db() as c:
    owner = c.execute("SELECT id FROM users WHERE username='admin'").fetchone()["id"]
    now = time.time()
    c.execute("INSERT INTO students(id,name,grade,created,owner_id) VALUES(?,?,?,?,?)", (student,"示例学生 · 模拟","六年级",now,owner))
    c.execute("INSERT INTO jobs(id,submit_key,user_id,student_id,day,status,result,revision,created,updated) VALUES(?,?,?,?,?,'review',?,1,?,?)", (job_id,uuid.uuid4().hex,owner,student,"2026-10-03",json.dumps(RESULT,ensure_ascii=False),now,now))
    c.execute("INSERT INTO materials(id,job_id,page,file_index,source_page,name,original,full,thumb) VALUES(?,?,1,0,1,?,?,?,?)",(material_id,job_id,'模拟原题资料（仅测试界面）',*paths))
    c.execute("INSERT INTO photos(id,job_id,page,name,original,full,thumb,material_id) VALUES(?,?,?,?,?,?,?,?)",(photo_id,job_id,1,"synthetic-demo.jpg",*paths,material_id))
    usage={'prompt_tokens':3000,'completion_tokens':1800,'prompt_cache_hit_tokens':1000,'prompt_cache_miss_tokens':2000,'completion_tokens_details':{'reasoning_tokens':600}}
    c.execute("INSERT INTO calls(job_id,user_id,kind,model,seconds,input_tokens,output_tokens,created,photo_id,usage_json,pricing_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              (job_id,owner,'grading','模拟用量 · deepseek-flash',1.5,3000,1800,now,photo_id,json.dumps(usage),json.dumps(app.price_usage('deepseek-flash',usage))))

if __name__ == "__main__":
    if os.getenv("AUTOGRADE_DEMO_PROGRESS") == "1":
        with app.db() as c:
            c.execute("UPDATE jobs SET status='queued',result=NULL WHERE id=?", (job_id,))
    uvicorn.run(app.app, host="127.0.0.1", port=8765)
