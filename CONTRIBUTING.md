# Contributing to AutoGrade / 贡献指南

Thanks for helping teachers review homework more efficiently.

## Before opening an issue
- Search existing issues; include OS, Python/browser versions and clear reproduction steps.
- Reproduce using **synthetic homework** or generated fixtures, never photos of real students.
- Do not post student names, chat records, API keys, session cookies, production logs containing identifiers, or school/teacher private data.

## Making changes
1. Work on a feature branch with a focused scope.
2. Add or update automated tests. Use PIL or in-memory fixtures for images.
3. Run `python -m unittest discover -s tests -v` and `for file in tests/test_*.js; do node "$file"; done` where supported.
4. For interface changes, test mobile and desktop layouts; use the synthetic Playwright scripts in `tests/browser/` where possible.
5. Include a concise description, screenshots made from synthetic data and risk notes in the PR.

## Product boundaries
- AI output remains a *draft* until the teacher verifies and confirms it.
- Keep photographs private and require authenticated access to them.
- Distinguish confirmed API charges from estimates and unknown usage.
- Changes to authentication, pupil-data isolation, upload parsing, or retention deserve regression tests and a security review.

See [SECURITY.md](SECURITY.md) for vulnerability reports and [docs/PRIVACY.md](docs/PRIVACY.md) for the basic data flow.
