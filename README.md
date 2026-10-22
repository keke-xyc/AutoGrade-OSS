# AutoGrade · 作业小笺

Self-hostable, teacher-reviewed AI homework grading workbench for primary-school mathematics.

一个可自行部署的小学数学作业辅助批改工作台。老师上传照片，模型给出逐题识别与初步判断，老师核对后生成家长回复并归档。**模型输出不能替代教师判断。**

## What it does / 功能

- 多张照片、HEIC/HEIF 与 PDF 原题资料
- 逐题核对、框选重识别、文字重新判题
- 学生历史与反馈归档、多教师账号隔离
- 私有图片存储、调用用量与费用估算
- 手机浏览器使用，深色与浅色模式
- 离线模拟演示：不需要真实学生照片或 API 密钥

## Try the offline demo / 无密钥演示

Requires Python 3.12 (recommended) and dependencies:

```bash
python -m venv .venv
# Linux/macOS
. .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python tests/preview_server.py
```

Open http://127.0.0.1:8765. The demo listens on loopback only.
Username: `admin`; password: `offline-preview-only`.
**Synthetic images and mock AI responses only.** Never expose the preview server to the Internet.

## Run your own instance / 私有部署

```bash
cp .env.example .env
# Enter a valid DEEPSEEK_API_KEY in .env and configure domain settings
docker compose run --rm --no-deps app python manage.py setup
docker compose up -d --build
```

Set `DOMAIN`, `PUBLIC_ORIGIN` and `COOKIE_SECURE=true` for real HTTPS deployment. Docker Compose starts Caddy for HTTPS; set DNS appropriately. Never commit `.env` or real homework data. For local testing without Caddy, follow `compose.private.yaml` and bind access through an SSH tunnel. Review the configuration before production use.

## Tests / 测试

```bash
python -m unittest discover -s tests -v
node tests/test_upload.js
node tests/test_navigation.js
node tests/test_review_actions.js
node tests/test_image_actions.js
node tests/test_theme.js
node tests/test_password_visibility.js
node tests/test_math_preview.js
```

Some integrations need extra system dependencies. Offline tests should not call a real model. Run them before shipping.

## Privacy and limitations / 隐私与限制

- This public snapshot contains **no historical student photos**, private Git history or production credentials.
- Real submissions are sent to the configured AI provider for analysis. Photos can contain identifying information even when the student's name is omitted from the prompt; obtain appropriate permission and anonymize data when possible.
- AI grading can be incorrect. Teachers must verify extracted work, answers and feedback before sending.
- Secure installation, legal requirements and data retention are the responsibility of the operator. Do not use a demo password in production.
- This project does not automatically read chats or send messages to parents.

## Development and contributing

Start with a reproducible bug report or feature proposal in GitHub Issues. Do not submit real students' work, API keys, tokens, server addresses or personal data. Submit focused pull requests with relevant tests. See `LICENSE` for this project's proposed MIT licensing; bundled KaTeX/MathLive components retain their own licenses.

This README is the **public-facing source**; private deployment notes and private fixtures are not published.
