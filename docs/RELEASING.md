# Release checklist / 开源发布核验

This document deliberately separates the **private development repository** from a **new public repository**. Do not change the private repository's visibility.

## Mandatory prepublication checks

- [ ] Confirm code ownership, contributors' authorizations, bundled asset licenses, and whether MIT is the desired project license.
- [ ] Review every file in the sanitized ZIP, especially `.env.example`, HTML, images, icons, vendored assets, tests, CI workflows and documentation.
- [ ] Confirm the package contains no pupil records, real handwriting, internal hosts, credentials, live admin password hashes, production DBs, backups, or private Git history.
- [ ] Run the exported-code Python and JavaScript tests on Linux and Windows as appropriate.
- [ ] Run Chromium smoke tests with **synthetic** screenshots and verify mobile layout, JS/CSS loading, and teacher review interaction.
- [ ] Set up a throwaway deployment with dummy data and no production API credentials.
- [ ] Add and check project description, documentation, licensing, vulnerability-reporting guidance and the release tag.
- [ ] Review international/territorial and student-data requirements for your actual deployments. A demo deployment does not make real pupil-data processing compliant.

## How to prepare a separate public repository

1. Download the latest successful **autograde-oss-review** artifact from the private OSS CI workflow. Inspect its SHA-256 and contents.
2. Extract it into a **new directory outside** the private checkout. Verify there is no `.git`, `.env`, `test_photos`, `data`, or `node_modules`.
3. Once all checks and owner approvals are complete, run `git init` **inside the extracted clean directory**, stage only verified files, and make a single initial commit.
4. Create a separate empty GitHub repository. Do not fork, mirror, merge, or push a branch from the private repository. Push only the new independent history.
5. Publish v0.1.0 after reviewing the exact public tree and validating CI in the new repository.

**Never publish the source preparation branch itself**: it inherits history from the original private repository, including the original photo fixtures.

## Codex for OSS application proof

Keep evidence of authentic maintainership, public releases, documentation, tests, community adoption, issues, pull requests and security practices. Do not claim fabricated users, stars or model performance.
