#!/usr/bin/env node

/**
 * RepoMerge — AI Orchestrator (Business Logic & Evaluation Agent)
 *
 * Watches `.agents/search_request.json` for a { city, skill } payload.
 * When detected:
 *   1. Searches GitHub REST API for local developers
 *   2. Fetches their public repository data
 *   3. Feeds repo data into an LLM (deepseek-v3.2:cloud via Ollama) to evaluate skill level
 *   4. Injects guaranteed demo profiles ("Krushna", "Sachit")
 *   5. Writes structured results to `.agents/analyzed_profiles.json`
 *   6. Logs every step to `.agents/claude_logs.txt`
 *
 * Communication with the other agents is EXCLUSIVELY via the
 * `.agents/` shared folder — no API calls between agents.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const OpenAI = require("openai");

// ─── Paths ───────────────────────────────────────────────────────────────────
const ROOT = join(import.meta.dirname, "..");
const AGENTS_DIR = join(ROOT, ".agents");
const SEARCH_REQUEST_PATH = join(AGENTS_DIR, "search_request.json");
const ANALYZED_PROFILES_PATH = join(AGENTS_DIR, "analyzed_profiles.json");
const CLAUDE_LOGS_PATH = join(AGENTS_DIR, "claude_logs.txt");

// ─── Config ─────────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "deepseek-v3.2:cloud";
const POLL_INTERVAL_MS = 2000;

// ─── Demo profiles (always included so the demo never breaks) ────────────────
function buildDemoProfiles(requestedSkill, requestedCity) {
  return [
    {
      username: "krushna1133",
      name: "Krushna",
      avatar_url: "https://avatars.githubusercontent.com/u/0?v=4",
      bio: "Full-stack developer from Nagpur, passionate about React, Node.js, and building developer tools. Hackathon enthusiast.",
      city: requestedCity || "Nagpur",
      location: requestedCity || "Nagpur",
      followers: 42,
      public_repos: 18,
      skills: [requestedSkill || "React", "Node.js", "TypeScript", "Next.js"],
      topSkills: [requestedSkill || "React", "Node.js", "TypeScript"],
      skillScores: { [requestedSkill || "React"]: 88 },
      skill_value: 88,
      summary: "Experienced React developer based in Nagpur with strong full-stack capabilities. Active open-source contributor.",
    },
    {
      username: "sachit-dev",
      name: "Sachit",
      avatar_url: "https://avatars.githubusercontent.com/u/0?v=4",
      bio: "Frontend developer in Nagpur, specializing in React and UI/UX. Building cool stuff at the intersection of design and code.",
      city: requestedCity || "Nagpur",
      location: requestedCity || "Nagpur",
      followers: 28,
      public_repos: 12,
      skills: [requestedSkill || "React", "JavaScript", "CSS", "Figma"],
      topSkills: [requestedSkill || "React", "JavaScript", "CSS"],
      skillScores: { [requestedSkill || "React"]: 82 },
      skill_value: 82,
      summary: "Creative frontend developer from Nagpur with a keen eye for design and solid React expertise.",
    },
  ];
}

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] AI Orchestrator: ${message}\n`;
  try {
    mkdirSync(AGENTS_DIR, { recursive: true });
    appendFileSync(CLAUDE_LOGS_PATH, line, "utf8");
  } catch {
    // Best-effort; don't crash if disk is flaky
  }
  process.stdout.write(line);
}

// ─── GitHub helpers ──────────────────────────────────────────────────────────
function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "RepoMerge-Evaluator",
  };
  if (GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText} — ${url}`);
  }
  return res.json();
}

async function searchGitHubUsers(city, skill) {
  const query = encodeURIComponent(`location:${city} ${skill}`);
  const url = `https://api.github.com/search/users?q=${query}&per_page=5`;
  log(`Searching GitHub: location=${city}, skill=${skill}`);
  const data = await fetchJSON(url);
  return (data.items || []).slice(0, 5);
}

async function getUserProfile(username) {
  return fetchJSON(`https://api.github.com/users/${username}`);
}

async function getUserRepos(username) {
  return fetchJSON(`https://api.github.com/users/${username}/repos?per_page=10&sort=updated`);
}

// ─── LLM evaluation (Ollama / deepseek-v3.2:cloud) ───────────────────────────
async function evaluateWithLLM(profile, repos, requestedSkill) {
  const openai = new OpenAI({
    apiKey: "ollama",                // required by SDK but unused by Ollama
    baseURL: OLLAMA_BASE_URL,
  });

  const repoSummary = repos.map((r) => ({
    name: r.name,
    description: r.description,
    language: r.language,
    stars: r.stargazers_count,
    forks: r.forks_count,
    topics: r.topics || [],
  }));

  const prompt = `You are a technical recruiter evaluating a developer's skill level.

Developer profile:
- Username: ${profile.login}
- Name: ${profile.name || "N/A"}
- Bio: ${profile.bio || "N/A"}
- Location: ${profile.location || "N/A"}
- Public repos: ${profile.public_repos}
- Followers: ${profile.followers}

Their top repositories:
${JSON.stringify(repoSummary, null, 2)}

The user is being evaluated for their proficiency in: "${requestedSkill}"

Return ONLY a valid JSON object (no markdown, no explanation) with exactly these fields:
{
  "skill_value": <number 1-100 representing overall proficiency in "${requestedSkill}">,
  "top_skills": <array of 3-5 strings, their strongest technical skills>,
  "skills": <array of all detectable skill strings>,
  "skillScores": <object mapping each detected skill to a number 1-100>,
  "summary": <one-sentence professional assessment>
}`;

  try {
    log(`Running LLM (${OLLAMA_MODEL}) evaluation on ${profile.login}...`);
    const completion = await openai.chat.completions.create({
      model: OLLAMA_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    const raw = completion.choices[0]?.message?.content || "{}";

    // Strip markdown code fences that llama3 may wrap around JSON
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();

    const parsed = JSON.parse(cleaned);

    // Validate required fields exist, fill gaps if the LLM was sloppy
    return {
      skill_value: Number(parsed.skill_value) || 50,
      top_skills: Array.isArray(parsed.top_skills) ? parsed.top_skills : [],
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      skillScores: typeof parsed.skillScores === "object" ? parsed.skillScores : {},
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
    };
  } catch (err) {
    log(`LLM evaluation failed for ${profile.login}: ${err.message}. Falling back to heuristic.`);
    return heuristicScore(profile, repos, requestedSkill);
  }
}

// ─── Heuristic fallback (no API key) ────────────────────────────────────────
function heuristicScore(profile, repos, requestedSkill) {
  const skillLower = (requestedSkill || "").toLowerCase();
  const languages = repos.map((r) => (r.language || "").toLowerCase());
  const topics = repos.flatMap((r) => (r.topics || []).map((t) => t.toLowerCase()));
  const descriptions = repos.map((r) => (r.description || "").toLowerCase()).join(" ");

  const allText = [...languages, ...topics, descriptions].join(" ");
  const hasExactSkill = allText.includes(skillLower);

  const skillMap = {};
  const seen = new Set();
  for (const lang of languages) {
    if (lang && !seen.has(lang)) {
      seen.add(lang);
      skillMap[lang] = Math.floor(Math.random() * 30) + 60; // 60-90
    }
  }
  if (hasExactSkill) {
    skillMap[skillLower] = 85;
  }

  const topSkills = Object.entries(skillMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name.charAt(0).toUpperCase() + name.slice(1));

  const skillValue = hasExactSkill ? 82 : Math.floor(Math.random() * 20) + 55;

  return {
    skill_value: skillValue,
    top_skills: topSkills,
    skills: topSkills,
    skillScores: skillMap,
    summary: `Developer with ${profile.public_repos} public repos. ${hasExactSkill ? `Active in ${requestedSkill}.` : "Generalist."}`,
  };
}

// ─── Main pipeline ───────────────────────────────────────────────────────────
async function runPipeline(city, skill) {
  log("─".repeat(60));
  log(`Pipeline triggered — city="${city}", skill="${skill}"`);

  // Step 1: Search GitHub for local developers
  log("Extracting GitHub data...");
  let ghUsers = [];
  try {
    ghUsers = await searchGitHubUsers(city, skill);
    log(`GitHub returned ${ghUsers.length} user(s) for location=${city}.`);
  } catch (err) {
    log(`GitHub search failed: ${err.message}. Will rely on demo profiles.`);
  }

  // Step 2: Enrich each user with profile + repos, then evaluate
  const evaluatedProfiles = [];

  for (const ghUser of ghUsers) {
    try {
      log(`Fetching profile for ${ghUser.login}...`);
      const [profile, repos] = await Promise.all([
        getUserProfile(ghUser.login),
        getUserRepos(ghUser.login),
      ]);

      log(`Evaluating ${ghUser.login}...`);
      const evaluation = await evaluateWithLLM(profile, repos, skill);

      evaluatedProfiles.push({
        username: profile.login,
        name: profile.name || profile.login,
        avatar_url: profile.avatar_url,
        bio: profile.bio || "",
        city: city,
        location: profile.location || city,
        followers: profile.followers,
        public_repos: profile.public_repos,
        ...evaluation,
      });
    } catch (err) {
      log(`Skipping ${ghUser.login}: ${err.message}`);
    }
  }

  // Step 3: Always inject demo profiles so the demo never breaks
  log("Injecting guaranteed demo profiles (Krushna, Sachit)...");
  const demoProfiles = buildDemoProfiles(skill, city);
  const allProfiles = [...evaluatedProfiles, ...demoProfiles];

  // Step 4: Write analyzed_profiles.json
  log(`Writing ${allProfiles.length} profile(s) to analyzed_profiles.json`);
  writeFileSync(ANALYZED_PROFILES_PATH, JSON.stringify(allProfiles, null, 2), "utf8");

  log("Pipeline complete. analyzed_profiles.json is ready for the matcher.");
  log("─".repeat(60));

  // Step 5: Reset search request so we don't re-trigger
  writeFileSync(SEARCH_REQUEST_PATH, JSON.stringify({}), "utf8");
}

// ─── Watcher ─────────────────────────────────────────────────────────────────
function readSearchRequest() {
  try {
    const raw = readFileSync(SEARCH_REQUEST_PATH, "utf8").trim();
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function hasValidRequest(payload) {
  return payload && typeof payload.city === "string" && payload.city.trim() !== ""
    && typeof payload.skill === "string" && payload.skill.trim() !== "";
}

async function main() {
  log("AI Orchestrator starting...");
  log(`Watching: ${SEARCH_REQUEST_PATH}`);
  log(`Poll interval: ${POLL_INTERVAL_MS}ms`);
  log(`LLM: ${OLLAMA_MODEL} at ${OLLAMA_BASE_URL}`);
  log(`GitHub token: ${GITHUB_TOKEN ? "configured" : "not set (rate-limited to 60 req/hr)"}`);

  // Check immediately in case a request is already waiting
  const initial = readSearchRequest();
  if (hasValidRequest(initial)) {
    await runPipeline(initial.city.trim(), initial.skill.trim());
  }

  // Poll loop
  setInterval(async () => {
    try {
      const payload = readSearchRequest();
      if (hasValidRequest(payload)) {
        await runPipeline(payload.city.trim(), payload.skill.trim());
      }
    } catch (err) {
      log(`Poller error: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);

  log("Watcher active. Press Ctrl+C to stop.");
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
