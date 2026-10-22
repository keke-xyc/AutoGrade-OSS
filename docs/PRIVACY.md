# Privacy and data flow / 隐私与数据流

AutoGrade is a **self-hosted codebase**, not a managed cloud service. Whoever deploys it controls the local deployment, retention rules, and access to records.

## Typical processing flow
1. An authenticated teacher uploads worksheet photographs, optionally with blank assignment reference pages.
2. The server stores the source and derived images and associates them with the teacher's account and assignment.
3. For real grading, the configured third-party AI provider receives prepared image contents and relevant prompt text. Image contents **may still show students' names or handwriting** even when the application does not send a separate student-name field.
4. The teacher reviews model suggestions and confirms or edits them before generating a parent response and archiving.
5. The database stores results, editing history and usage estimates. Backups can contain sensitive content.

## Recommended operator controls
- Inform students/guardians as required and obtain appropriate authority before uploading schoolwork.
- Remove unnecessary identifiable information from photos before submission.
- Restrict teacher/admin permissions, credentials and storage access; review API provider terms and retention.
- Protect backups and avoid placing student records in source control, support tickets, analytics screenshots or public demos.
- Use generated sample worksheets for demonstrations, bug reports and open-source collaboration.
- Establish data retention, deletion, access logging and incident handling appropriate to the deployment.

## Scope and limitations
There is no guarantee that an AI model's judgment, OCR output or assessment is correct. Anonymization of photograph contents is **not automatic**. The open-source distribution contains no real student photographs or private application database.
