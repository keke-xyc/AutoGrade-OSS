# Security policy / 安全说明

## Supported versions
Security updates are intended for the latest released version. There is no long-term support guarantee for older releases.

## Reporting a vulnerability
**Do not post an exploit, credentials, student photos or identifying records in public GitHub Issues.** Prefer GitHub's private vulnerability reporting if the repository enables it. If private reporting is unavailable, contact the repository maintainer through an explicitly listed private channel before disclosing details.

Include affected version, a minimal synthetic-data reproduction, expected vs. observed behavior, and potential impact. Never include live API tokens or actual pupil records.

## Self-hosting checklist
- Configure a unique admin password and server-side session settings. Never reuse demo credentials.
- Serve real accounts over HTTPS, use secure cookies, and limit exposure of application ports.
- Keep `.env`, SQLite, uploaded images and backups outside publicly served web roots; restrict filesystem access.
- Retain and delete pupil data in line with applicable rules and organizational consent.
- Treat photos and AI provider requests as potential personal-data disclosures; review data processing terms before production use.
- Do not confuse the offline mock preview with a production-safe environment.

Security review is ongoing; no security certification or complete absence of vulnerabilities is claimed.
