import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const AGENTS_DIR = path.join(process.cwd(), '.agents');
const FINAL_MATCH_PATH = path.join(AGENTS_DIR, 'final_match.json');

export async function GET() {
  try {
    if (!fs.existsSync(FINAL_MATCH_PATH)) {
      return NextResponse.json({});
    }
    const data = fs.readFileSync(FINAL_MATCH_PATH, 'utf8');
    const parsed = data.trim() ? JSON.parse(data) : {};
    return NextResponse.json(parsed);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
