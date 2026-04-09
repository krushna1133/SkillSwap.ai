#!/usr/bin/env node

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..");
const AGENTS_DIR = join(ROOT, ".agents");
const SEARCH_REQUEST_PATH = join(AGENTS_DIR, "search_request.json");
const ANALYZED_PROFILES_PATH = join(AGENTS_DIR, "analyzed_profiles.json");
const FINAL_MATCH_PATH = join(AGENTS_DIR, "final_match.json");
const MATCHER_LOGS_PATH = join(AGENTS_DIR, "matcher_logs.txt");

const POLL_INTERVAL_MS = 1000;

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] Matcher: ${message}\n`;
  try {
    mkdirSync(AGENTS_DIR, { recursive: true });
    appendFileSync(MATCHER_LOGS_PATH, line, "utf8");
  } catch {}
  process.stdout.write(line);
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function scoreProfile(profile, requestedSkill, requestedCity) {
  const skill = normalizeText(requestedSkill);
  const city = normalizeText(requestedCity);

  let score = 0;
  const reasons = [];

  const skillSources = [];
  if (Array.isArray(profile?.skills)) {
    skillSources.push(...profile.skills);
  }
  if (Array.isArray(profile?.topSkills)) {
    skillSources.push(...profile.topSkills);
  }

  const normalizedSkills = skillSources.map(normalizeText).filter(Boolean);
  const exactSkillHit = normalizedSkills.find((s) => s === skill);
  const partialSkillHit = normalizedSkills.find((s) => s.includes(skill) || skill.includes(s));

  if (exactSkillHit) {
    score += 100;
    reasons.push("exact skill match");
  } else if (partialSkillHit) {
    score += 70;
    reasons.push("partial skill match");
  }

  if (profile?.skillScores && typeof profile.skillScores === "object") {
    for (const [name, value] of Object.entries(profile.skillScores)) {
      const normalizedName = normalizeText(name);
      if (normalizedName === skill || normalizedName.includes(skill) || skill.includes(normalizedName)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
          score += Math.max(0, Math.min(100, numeric));
          reasons.push("AI skill score bonus");
          break;
        }
      }
    }
  }

  const searchableText = normalizeText(
    [profile?.bio, profile?.summary].filter(Boolean).join(" ")
  );
  if (skill && searchableText.includes(skill)) {
    score += 30;
    reasons.push("profile text mentions skill");
  }

  const locationText = normalizeText([profile?.city, profile?.location].filter(Boolean).join(" "));
  if (city && locationText) {
    if (locationText === city) {
      score += 35;
      reasons.push("exact city match");
    } else if (locationText.includes(city) || city.includes(locationText)) {
      score += 20;
      reasons.push("partial city match");
    }
  }

  const reputationBoost = Number(profile?.followers || 0) / 10 + Number(profile?.public_repos || 0) / 20;
  if (Number.isFinite(reputationBoost) && reputationBoost > 0) {
    score += Math.min(20, reputationBoost);
  }

  return { score, reasons };
}

function pickBestMatch(profiles, requestedSkill, requestedCity) {
  const ranked = profiles
    .map((profile) => {
      const { score, reasons } = scoreProfile(profile, requestedSkill, requestedCity);
      return { profile, score, reasons };
    })
    .sort((a, b) => b.score - a.score);

  return ranked[0] || null;
}

function createJitsiRoomId(city, skill) {
  const sanitize = (v) => String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `repomerge-${sanitize(city)}-${sanitize(skill)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

async function runMatch(city, skill) {
  log(`Match triggered — city="${city}", skill="${skill}"`);

  let profiles = [];
  try {
    const raw = readFileSync(ANALYZED_PROFILES_PATH, "utf8");
    profiles = JSON.parse(raw.trim() || "[]");
  } catch (err) {
    log(`Failed to read profiles: ${err.message}`);
    return;
  }

  if (!profiles.length) {
    log("No profiles available for matching.");
    return;
  }

  const best = pickBestMatch(profiles, skill, city);
  if (!best) {
    log("No match found.");
    return;
  }

  const roomId = createJitsiRoomId(city, skill);
  const jitsiUrl = `https://meet.jit.si/${roomId}`;

  const result = {
    requestedCity: city,
    requestedSkill: skill,
    matchedAt: new Date().toISOString(),
    roomId,
    jitsiUrl,
    matchConfidence: best.score,
    matchReasons: best.reasons,
    matchedUser: best.profile,
  };

  writeFileSync(FINAL_MATCH_PATH, JSON.stringify(result, null, 2), "utf8");
  log(`Match secured: ${best.profile.username} (score: ${best.score})`);
}

let lastSearchRequest = "";

function readSearchRequest() {
  try {
    const raw = readFileSync(SEARCH_REQUEST_PATH, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function main() {
  log("Matcher starting...");
  log(`Watching: ${ANALYZED_PROFILES_PATH}`);

  setInterval(async () => {
    try {
      const payload = readSearchRequest();
      const key = `${payload.city}-${payload.skill}`;
      
      if (key && key !== lastSearchRequest) {
        lastSearchRequest = key;
        
        await new Promise(r => setTimeout(r, 1000));
        
        const profilesRaw = readFileSync(ANALYZED_PROFILES_PATH, "utf8").trim();
        const profiles = profilesRaw ? JSON.parse(profilesRaw) : [];
        
        if (profiles.length > 0) {
          await runMatch(payload.city, payload.skill);
        }
      }
    } catch (err) {
      log(`Error: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);

  log("Matcher active. Press Ctrl+C to stop.");
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
