# AutoGrade OSS v0.1.0

Initial independent open-source release of **AutoGrade · 作业小笺**, a self-hosted, teacher-reviewed AI homework workflow for primary-school mathematics.

### Highlights
- Photograph and optional reference-sheet upload, including HEIC/HEIF/PDF-related support.
- Per-question human review, targeted re-recognition and judgment correction before parent feedback.
- Teacher-account isolation, student history, private source images and usage accounting.
- Mobile-first interface, themes and improved queue/upload/review workflows.
- Offline preview driven by fictional generated worksheet images and mock model responses (no API credentials needed).

### Quality & security notes
- Pre-release private CI verified 53 offline Python tests, nine front-end JavaScript test scripts, and real Chromium review and upload/queue smoke tests against an allowlisted export.
- This standalone release contains neither the private development repository's Git history nor real pupil photos.
- Real grading uses a configured third-party model provider; image content may contain personal information. Please obtain appropriate permission, verify results and protect stored data.
- A real student-data deployment requires a properly configured HTTPS service and operator-controlled retention/security policies.
- The system is not a certified assessment tool and cannot replace teachers' professional review.

### Getting started
See [README.md](../README.md), [SECURITY.md](../SECURITY.md), [PRIVACY.md](PRIVACY.md) and [RELEASING.md](RELEASING.md).

### Requirements
Python 3.12 is recommended for the offline demonstration. Production Docker Compose instructions and configuration examples are in the README.
