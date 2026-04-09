import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";

const AGENTS_DIR = path.join(process.cwd(), ".agents");
const ANALYZED_PROFILES_PATH = path.join(AGENTS_DIR, "analyzed_profiles.json");
const SEARCH_REQUEST_PATH = path.join(AGENTS_DIR, "search_request.json");
const FINAL_MATCH_PATH = path.join(AGENTS_DIR, "final_match.json");
const COPILOT_LOGS_PATH = path.join(AGENTS_DIR, "copilot_logs.txt");

const POLL_INTERVAL_MS = Number(process.env.MATCH_POLL_INTERVAL_MS || 1000);
const POLL_TIMEOUT_MS = Number(process.env.MATCH_POLL_TIMEOUT_MS || 30000);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function sanitizeForRoom(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

async function appendLog(message) {
  const timestamp = new Date().toISOString();
  await fs.mkdir(AGENTS_DIR, { recursive: true });
  await fs.appendFile(COPILOT_LOGS_PATH, `[${timestamp}] ${message}\n`, "utf8");
}

function getProfilesList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.profiles)) return payload.profiles;
  return [];
}

function scoreProfile(profile, requestedSkill, requestedCity) {
  const skill = normalizeText(requestedSkill);
  const city = normalizeText(requestedCity);

  let score = 0;
  const reasons = [];

  const skillSources = [];
  if (Array.isArray(profile?.skills)) {
    for (const item of profile.skills) {
      if (typeof item === "string") skillSources.push(item);
      if (item && typeof item === "object") {
        if (typeof item.name === "string") skillSources.push(item.name);
        if (typeof item.skill === "string") skillSources.push(item.skill);
      }
    }
  }
  if (Array.isArray(profile?.techStack)) {
    skillSources.push(...profile.techStack);
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
    [
      profile?.bio,
      profile?.summary,
      profile?.headline,
      profile?.about,
      profile?.analysis,
      profile?.notes,
    ]
      .filter(Boolean)
      .join(" ")
  );
  if (skill && searchableText.includes(skill)) {
    score += 30;
    reasons.push("profile text mentions skill");
  }

  const locationText = normalizeText([profile?.city, profile?.location, profile?.region].filter(Boolean).join(" "));
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

function createJitsiRoomId(city, skill) {
  const cityPart = sanitizeForRoom(city) || "city";
  const skillPart = sanitizeForRoom(skill) || "skill";
  const nonce = randomBytes(4).toString("hex");
  return `repomerge-${cityPart}-${skillPart}-${Date.now()}-${nonce}`;
}

async function waitForProfiles() {
  const started = Date.now();

  while (Date.now() - started <= POLL_TIMEOUT_MS) {
    try {
      const raw = await fs.readFile(ANALYZED_PROFILES_PATH, "utf8");
      const parsed = raw.trim() ? JSON.parse(raw) : [];
      const profiles = getProfilesList(parsed);
      if (profiles.length > 0) return profiles;
    } catch {
      // keep polling; the producer may still be writing.
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for analyzed profiles.");
}

async function readSearchRequest() {
  try {
    const raw = await fs.readFile(SEARCH_REQUEST_PATH, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
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

export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const searchRequest = await readSearchRequest();
    const requestedSkill =
      body?.skill || body?.requestedSkill || searchRequest?.skill || searchRequest?.requestedSkill || "";
    const requestedCity =
      body?.city || body?.requestedCity || searchRequest?.city || searchRequest?.requestedCity || "";

    if (!requestedSkill) {
      await appendLog("Match request rejected: missing skill.");
      return NextResponse.json({ error: "Missing required field: skill" }, { status: 400 });
    }

    await appendLog(`Match request received (city="${requestedCity || "n/a"}", skill="${requestedSkill}").`);
    await appendLog("Waiting for analyzed profiles...");

    const profiles = await waitForProfiles();
    await appendLog(`Profiles detected (${profiles.length} profile(s)).`);
    await appendLog("Executing match algorithm...");

    const best = pickBestMatch(profiles, requestedSkill, requestedCity);
    if (!best) {
      await appendLog("No profiles available for matching.");
      return NextResponse.json({ error: "No candidate profiles available." }, { status: 404 });
    }

    const roomId = createJitsiRoomId(requestedCity, requestedSkill);
    const jitsiUrl = `https://meet.jit.si/${roomId}`;

    const result = {
      requestedCity,
      requestedSkill,
      matchedAt: new Date().toISOString(),
      roomId,
      jitsiUrl,
      matchConfidence: best.score,
      matchReasons: best.reasons,
      matchedUser: best.profile,
    };

    await fs.mkdir(AGENTS_DIR, { recursive: true });
    await fs.writeFile(FINAL_MATCH_PATH, JSON.stringify(result, null, 2), "utf8");
    await appendLog("Match secured.");

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await appendLog(`Match failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

