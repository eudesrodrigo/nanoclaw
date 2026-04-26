---
name: job-search
description: Search job sites for matching positions, evaluate against user profile, notify via Telegram, and save to GitHub Issues. Trigger when user asks to search for jobs or on scheduled runs.
allowed-tools: Bash(agent-browser:*), Bash(gh *), Bash(node *)
---

# Job Search

Automated job search engine. Fetches the user's experience and preferences from GitHub, searches job sites, evaluates matches, notifies via Telegram, and saves to GitHub Issues with dedup.

## Config

```yaml
experience_url: eudesrodrigo/career-ops/cv.md
preferences_url: eudesrodrigo/career-ops/config/profile.yml
portals_url: eudesrodrigo/career-ops/portals.yml
output_repo: eudesrodrigo/career-ops
output_label: job-search
project_number: 4
project_owner: eudesrodrigo
match_threshold: 75
auto_save_threshold: 90
target_new_jobs: 15
```

## Rules

- **Always use `send_message` with plain text.** Never use cards, structured outputs, or any other format. The Telegram adapter only delivers plain text messages — anything else is silently dropped.
- **Use Telegram formatting only:** single `*asterisks*` for bold, `_underscores_` for italic, `•` for bullets. No markdown headings, no `**double asterisks**`, no `[links](url)`.
- **LinkedIn first.** Always start with LinkedIn. After finishing LinkedIn, ask the user if they want to search other sites too. Do not search other sites without asking.

## Workflow

The workflow has two phases: SETUP (steps 1-3, run once), then AUTHENTICATE + LOOP per site.

### 1. AUTHENTICATE — Log into LinkedIn

This is the very first step. LinkedIn sessions expire frequently, so you must verify you are logged in before doing anything else.

1. Open LinkedIn and check if you are already logged in:
   ```bash
   agent-browser open "https://www.linkedin.com/feed/"
   agent-browser snapshot -i
   ```

2. If you see a login page (sign-in form, "Join now", etc.) instead of the feed, you need to log in:
   ```bash
   agent-browser auth login linkedin
   ```

3. If a TOTP 2FA prompt appears after login, generate the code:
   ```bash
   node -e "
   const secret = require('/workspace/agent/.agent-browser/totp-secrets.json').linkedin.secret;
   const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
   const decode = s => { let b='',r=new Uint8Array(Math.floor(s.length*5/8)); s.toUpperCase().split('').forEach(c=>{b+=base32.indexOf(c).toString(2).padStart(5,'0')}); for(let i=0;i<r.length;i++) r[i]=parseInt(b.slice(i*8,i*8+8),2); return r; };
   const key = decode(secret);
   const time = Math.floor(Date.now()/30000);
   const buf = Buffer.alloc(8); buf.writeUInt32BE(Math.floor(time/0x100000000),0); buf.writeUInt32BE(time>>>0,4);
   const hmac = require('crypto').createHmac('sha1', Buffer.from(key)).update(buf).digest();
   const off = hmac[hmac.length-1]&0xf;
   const code = ((hmac.readUInt32BE(off)&0x7fffffff)%1000000).toString().padStart(6,'0');
   console.log(code);
   "
   ```
   Fill the 2FA field with the generated code.

4. Verify login succeeded — snapshot again and confirm you see the LinkedIn feed, not a login page. If login failed, notify the user via `send_message` and stop.

Only proceed to the next steps once you have confirmed you are logged into LinkedIn.

### 2. LOAD — Fetch config files

Fetch all three config files from GitHub:

```bash
gh api repos/eudesrodrigo/career-ops/contents/cv.md --jq '.content | @base64d' > /tmp/experience.md
gh api repos/eudesrodrigo/career-ops/contents/config/profile.yml --jq '.content | @base64d' > /tmp/preferences.yml
gh api repos/eudesrodrigo/career-ops/contents/portals.yml --jq '.content | @base64d' > /tmp/portals.yml
```

Read all three files. Extract the `title_filter` section from `portals.yml` — you need `positive`, `negative`, and `seniority_boost` keyword lists.

### 2. PLAN — Generate search queries

Analyze the experience and preferences together to generate targeted search queries.

- The experience file drives **specificity**: if the user has 8 years of Python + LLM experience, search "Senior AI Engineer" or "Staff ML Engineer", not generic "Python Developer".
- The preferences file sets **constraints**: location, remote policy, salary range, company size, industries to target or avoid.
- Generate 3-5 search queries that combine the user's strongest skills with their target role level.

### 3. DEDUP — Build seen set

Fetch all existing issues with the output label to avoid creating duplicates:

```bash
gh issue list --repo eudesrodrigo/career-ops --label job-search --state all --json body --limit 200 --jq '.[].body'
```

Extract all `<!-- job-id:*:* -->` tags from issue bodies. Build a set of seen job IDs (e.g. `linkedin:4399403309`).

### 5. MAIN LOOP — Process jobs one at a time (LinkedIn)

Navigate to the first search query:

```bash
agent-browser open "https://www.linkedin.com/jobs/search/?keywords={first_query}&f_TPR=r86400"
agent-browser snapshot -i
```

The `f_TPR=r86400` filter limits results to the last 24 hours.

Initialize a counter: `processed = 0`. Repeat this loop until `processed == target_new_jobs` (15).

For each job listing visible on the page:

#### 5a. Extract basic info

Click the job card to open the description panel. Extract:
- **title** — job title text
- **company** — company name
- **job_id** — from the URL path `/jobs/view/{id}/`

#### 5b. Quick checks — skip or continue

1. **Dedup:** Is `{source}:{job_id}` in the seen set? → **Skip**, move to next listing.
2. **Title filter:** Does the title pass `title_filter` from portals.yml?
   - At least **1 `positive` keyword** must match (case-insensitive)
   - **0 `negative` keywords** may match (case-insensitive)
   - Note `seniority_boost` matches for scoring
   - Fails filter? → **Skip**, move to next listing.

#### 5c. Evaluate

Extract the remaining fields from the description panel:
- **location**, **salary**, **remote_status**, **type**, **job_url**, **requirements**

Score a **match percentage (0-100)** based on:
- Skills overlap (tech stack, languages, frameworks)
- Experience level alignment (years required vs. user's years)
- Role type fit (the role matches what the user is looking for)
- Location/remote compatibility with preferences
- Salary range alignment (if available)
- Company/industry fit with preferences
- `seniority_boost` keyword matches in the title → +5% bonus

**match < `match_threshold` (75%)?** → **Skip**, move to next listing.

#### 5d. Notify + Save

**If match ≥ `auto_save_threshold` (90%):**

1. Create the GitHub issue immediately (see SAVE below)
2. Notify the user it was already saved:

```
✅ *Vaga salva automaticamente*

*{title}* — {company}
📍 {location}
💰 {salary}

*Match: {score}%*
✅ {strong_match_reason_1}
✅ {strong_match_reason_2}
⚠️ {concern_if_any}

🔗 {url}
📋 Issue criado: {issue_url}
```

3. `processed += 1`

**If match 75-89%:**

1. Notify the user and ask for confirmation:

```
*Vaga encontrada*

*{title}* — {company}
📍 {location}
💰 {salary}

*Match: {score}%*
✅ {match_reason_1}
✅ {match_reason_2}
⚠️ {concern_1}

🔗 {url}

Salvar no board?
```

2. Wait for the user's response.
3. If confirmed → create the GitHub issue (see SAVE below).
4. `processed += 1` (regardless of whether the user confirmed — the job was presented and decided on).

#### 5e. Next listing

Move to the next job card on the page. If no more cards are visible:
- Scroll down to load more listings, re-snapshot
- If no more results for this query, navigate to the next search query
- If all queries are exhausted, widen the search (remove the 24h time filter `f_TPR`, broaden keywords)
- If still no results, stop and tell the user how many jobs were processed

#### SAVE — Create GitHub Issue

```bash
gh issue create \
  --repo eudesrodrigo/career-ops \
  --title "{company} — {title}" \
  --label "job-search" \
  --label "match:{score}" \
  --body "$(cat <<'ISSUE_EOF'
{url}

**{remote_status} | {type} | {location} | {salary} | Match: {score}%**

{2-3 line analysis in Portuguese — what the company does, why it matches, notable details}

**Stack:** {tech_stack}
**Level:** {level}
**Experience:** {years_required}

<!-- job-id:{source}:{id} -->
ISSUE_EOF
)"
```

If match ≥ 90%, also add `--label "PRIORIDADE"`.

Then add the issue to the project board:

```bash
gh project item-add {project_number} --owner {project_owner} --url {issue_url}
```

Add the job ID to the seen set so it won't be processed again if encountered in a later query.

### 6. ASK ABOUT OTHER SITES

After the LinkedIn loop finishes (target reached or results exhausted), summarize what was found and ask the user:

```
*Busca no LinkedIn concluída*

{processed} vagas avaliadas, {saved} salvas no board.

Quer que eu busque em outros sites também?
```

If the user says yes, authenticate on the next site and repeat the MAIN LOOP (step 5) for that site. If no, stop.

## Issue format reference

The issue format matches the user's existing convention:

```
Title: {company} — {title}

Labels:
  - job-search (always)
  - match:{score} (always, e.g. "match:85")
  - PRIORIDADE (if match ≥ 90%)

Body:
{url}

**{remote_status} | {type} | {location} | {salary} | Match: {score}%**

{2-3 line analysis in Portuguese}

**Stack:** {tech_stack}
**Level:** {level}
**Experience:** {years_required}

<!-- job-id:{source}:{id} -->
```

The `<!-- job-id:{source}:{id} -->` HTML comment is invisible on GitHub but machine-searchable for dedup.

## Adding new sites

To add a new job site, create a new subsection under step 4 (SEARCH) following the LinkedIn pattern:

1. Authentication instructions (if needed)
2. Search URL template with query placeholder
3. Navigation and snapshot strategy
4. Data extraction mapping (which elements contain title, company, etc.)
5. Job ID extraction (how to get a unique ID from the URL or page)

The rest of the workflow (pre-filter, eval, notify, save) is site-agnostic.
