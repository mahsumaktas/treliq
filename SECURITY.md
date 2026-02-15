# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.3.x   | ✅        |
| < 0.3   | ❌        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Email **mahsum@mahsumaktas.com** with details
3. Include steps to reproduce if possible

You can expect an initial response within 48 hours.

## Security Considerations

- Treliq uses GitHub tokens with minimal required permissions (`read` for repos, `write` for PR comments)
- Gemini API keys are passed via environment variables, never stored in code
- No user data is collected or transmitted beyond GitHub and Gemini API calls
