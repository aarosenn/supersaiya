---
name: web-scraping
description: Extract and scrape structured information from websites and URLs
version: 1.0.0
author: SuperSaiya
triggers:
  - "scrape"
  - "crawl"
  - "extract website"
  - "fetch url content"
dependencies:
  mcp:
    - "firecrawl"
  tools:
    - "bash"
tags:
  - "web"
  - "research"
---

# Web Scraping & Content Extraction Skill

## When to use this skill
Use this skill whenever the user requests extracting text, tables, articles, documentation, or links from external websites.

## Workflow
1. **Identify the target URL(s)** from user prompt.
2. If `firecrawl` MCP server is available:
   - Use `firecrawl_scrape` to retrieve high-fidelity markdown or clean HTML.
   - Use `firecrawl_crawl` for multiple linked pages.
3. If no MCP server is configured:
   - Use `curl -sL <url>` via bash or Node fetch to extract the content.
4. Clean and summarize the output:
   - Remove boilerplate, navigation links, and cookies disclaimers.
   - Extract tables into clean markdown tables.
   - Extract code snippets in appropriate fenced markdown blocks.
