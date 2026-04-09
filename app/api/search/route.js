import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

const AGENTS_DIR = path.join(process.cwd(), '.agents');
const SEARCH_REQUEST_PATH = path.join(AGENTS_DIR, 'search_request.json');

export async function POST(request) {
  try {
    const body = await request.json();
    const { city, skill } = body;

    if (!city || !skill) {
      return NextResponse.json({ error: 'Missing city or skill' }, { status: 400 });
    }

    await fs.mkdir(AGENTS_DIR, { recursive: true });
    await fs.writeFile(SEARCH_REQUEST_PATH, JSON.stringify({ city, skill }), 'utf8');

    return NextResponse.json({ success: true, city, skill });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
