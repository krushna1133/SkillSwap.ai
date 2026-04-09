"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:5001";

const CITIES = [
  "Nagpur",
  "Mumbai",
  "Delhi",
  "Bangalore",
  "Hyderabad",
  "Chennai",
  "Pune",
  "Kolkata",
  "Cape Town",
  "Johannesburg",
  "London",
  "New York",
  "San Francisco",
  "Berlin",
  "Tokyo",
  "Sydney",
];

const POPULAR_SKILLS = [
  "React",
  "Python",
  "JavaScript",
  "TypeScript",
  "Node.js",
  "Go",
  "Rust",
  "Java",
  "Swift",
  "Kotlin",
  "Vue.js",
  "Next.js",
  "AI",
  "ML",
];

export default function Home() {
  const [city, setCity] = useState("");
  const [skill, setSkill] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [matchResult, setMatchResult] = useState(null);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const logsEndRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      setIsConnected(true);
      setLogs((prev) => [...prev, `[client] Connected to backend: ${SOCKET_URL}`].slice(-100));
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
      setLogs((prev) => [...prev, "[client] Backend disconnected"].slice(-100));
      setIsSearching(false);
    });

    socket.on("system_log", (line) => {
      setLogs((prev) => [...prev, String(line)].slice(-100));
    });

    socket.on("search_ack", (payload) => {
      setLogs((prev) => [...prev, `[client] Search accepted for ${payload.city}/${payload.skill}`].slice(-100));
    });

    socket.on("match_result", (result) => {
      setMatchResult(result);
      setIsSearching(false);
    });

    socket.on("match_error", (err) => {
      const message = typeof err?.error === "string" ? err.error : "Match failed.";
      setLogs((prev) => [...prev, `[client] ${message}`].slice(-100));
      setIsSearching(false);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const handleSearch = (e) => {
    e.preventDefault();
    if (!city.trim() || !skill.trim() || !socketRef.current || !isConnected) return;

    setIsSearching(true);
    setMatchResult(null);
    socketRef.current.emit("request_match", { city: city.trim(), skill: skill.trim() });
  };

  const matchedUser = matchResult?.matchedUser || {};
  const matchedSkills = matchedUser.skills || matchedUser.topSkills || [];

  return (
    <div className="min-h-screen bg-[#F8F7F4] text-[#2D2D2D] font-['Outfit',sans-serif]">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-gradient-to-br from-amber-200/30 to-transparent rounded-full blur-3xl" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-gradient-to-tl from-emerald-200/30 to-transparent rounded-full blur-3xl" />
      </div>

      <main className="relative z-10 max-w-5xl mx-auto px-6 py-20">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-white/60 backdrop-blur-sm rounded-full border border-[#2D2D2D]/10 mb-6">
            <span className={`w-2 h-2 rounded-full ${isConnected ? "bg-emerald-500" : "bg-amber-500"}`} />
            <span className="text-sm font-medium text-[#2D2D2D]/70">
              {isConnected ? "Socket Connected" : "Socket Disconnected"}
            </span>
          </div>
          <h1 className="text-6xl font-bold tracking-tight mb-4">
            Find Your <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-600 to-emerald-600">SkillMatch</span>
          </h1>
          <p className="text-xl text-[#2D2D2D]/60 max-w-2xl mx-auto">
            Connect with developers who match your city and skills. Get paired instantly.
          </p>
        </div>

        <form
          onSubmit={handleSearch}
          className="bg-white/70 backdrop-blur-xl rounded-3xl p-8 border border-[#2D2D2D]/10 shadow-[0_8px_32px_rgba(0,0,0,0.04)] mb-12"
        >
          <div className="grid md:grid-cols-2 gap-6 mb-6">
            <div>
              <label className="block text-sm font-semibold mb-2 text-[#2D2D2D]/70">City</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Enter city name..."
                list="cities"
                className="w-full px-5 py-4 bg-[#F8F7F4] border border-[#2D2D2D]/15 rounded-xl text-lg transition-all focus:outline-none focus:border-[#2D2D2D]/30 focus:ring-4 focus:ring-[#2D2D2D]/5"
              />
              <datalist id="cities">
                {CITIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="block text-sm font-semibold mb-2 text-[#2D2D2D]/70">Skill</label>
              <input
                type="text"
                value={skill}
                onChange={(e) => setSkill(e.target.value)}
                placeholder="Enter skill..."
                list="skills"
                className="w-full px-5 py-4 bg-[#F8F7F4] border border-[#2D2D2D]/15 rounded-xl text-lg transition-all focus:outline-none focus:border-[#2D2D2D]/30 focus:ring-4 focus:ring-[#2D2D2D]/5"
              />
              <datalist id="skills">
                {POPULAR_SKILLS.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
          </div>
          <button
            type="submit"
            disabled={isSearching || !isConnected || !city.trim() || !skill.trim()}
            className="w-full py-4 bg-[#2D2D2D] text-white font-semibold text-lg rounded-xl transition-all hover:bg-[#1a1a1a] disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-lg hover:shadow-[#2D2D2D]/20 active:scale-[0.98]"
          >
            {isSearching ? (
              <span className="inline-flex items-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Searching for your match...
              </span>
            ) : (
              "Find My Match"
            )}
          </button>
        </form>

        {matchResult && (
          <div className="bg-white/80 backdrop-blur-xl rounded-3xl p-8 border border-[#2D2D2D]/10 shadow-[0_8px_32px_rgba(0,0,0,0.04)] mb-12">
            <div className="flex items-center gap-3 mb-6">
              <span className="w-3 h-3 bg-emerald-500 rounded-full" />
              <span className="font-semibold text-emerald-700">Match Found!</span>
            </div>

            <div className="flex flex-col md:flex-row gap-8">
              <div className="flex-shrink-0">
                <img
                  src={matchedUser.avatar_url || "https://avatars.githubusercontent.com/u/0?v=4"}
                  alt={matchedUser.name || "Matched developer"}
                  className="w-24 h-24 rounded-2xl object-cover border-2 border-[#2D2D2D]/10"
                />
              </div>
              <div className="flex-grow">
                <h3 className="text-2xl font-bold mb-1">{matchedUser.name || "Developer"}</h3>
                <p className="text-[#2D2D2D]/60 mb-3">@{matchedUser.username || "unknown"}</p>
                <p className="text-[#2D2D2D]/80 mb-4">{matchedUser.bio || matchedUser.summary || "No summary available."}</p>

                <div className="flex flex-wrap gap-2 mb-4">
                  {matchedSkills.map((s, i) => (
                    <span key={`${s}-${i}`} className="px-3 py-1 bg-amber-100 text-amber-800 text-sm font-medium rounded-full">
                      {s}
                    </span>
                  ))}
                </div>

                <a
                  href={matchResult.jitsiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-semibold rounded-xl hover:shadow-lg hover:shadow-emerald-500/30 transition-all"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Join Video Call
                </a>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-center">
          <button onClick={() => setShowLogs(!showLogs)} className="text-sm text-[#2D2D2D]/50 hover:text-[#2D2D2D]/80 transition-colors">
            {showLogs ? "Hide" : "Show"} System Logs
          </button>
        </div>

        {showLogs && (
          <div className="mt-4 bg-[#1a1a1a] text-[#a0a0a0] rounded-xl p-4 font-mono text-xs max-h-64 overflow-y-auto">
            {logs.map((line, i) => (
              <div key={i} className="mb-1">
                {line}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </main>
    </div>
  );
}
