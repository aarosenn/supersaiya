---
name: code-review
description: Multi-axis code review covering correctness, performance, security, and edge cases
version: 1.0.0
author: SuperSaiya
triggers:
  - "code review"
  - "review pr"
  - "review code"
  - "audit code"
  - "check quality"
dependencies:
  tools:
    - "read"
    - "grep"
tags:
  - "quality"
  - "engineering"
---

# Code Review & Quality Assurance Skill

## Objectives
Perform a systematic and rigorous code review on proposed changes or specified files.

## Review Axes
1. **Logic & Correctness**: Does the code behave as expected under all valid and invalid inputs?
2. **Security**: Look for command injection, path traversal, untrusted deserialization, and missing bounds checks.
3. **Performance**: Avoid N+1 queries, unindexed lookups, quadratic complexity loops, and unbounded buffers.
4. **Error Handling**: Are errors propagated cleanly with meaningful messages rather than being swallowed?
5. **Types & Style**: Are TypeScript/Go types rigorous without unnecessary `any` or unsafely cast assertions?

## Report Format
Present findings grouped by severity:
- 🔴 **Critical / Blocking**
- 🟡 **Warnings / Improvements**
- 💡 **Suggestions / Cleanups**
