import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    const claudePath = path.join(process.cwd(), '.agents', 'claude_logs.txt');
    const copilotPath = path.join(process.cwd(), '.agents', 'copilot_logs.txt');

    let claudeLogs = '';
    let copilotLogs = '';

    if (fs.existsSync(claudePath)) {
      claudeLogs = fs.readFileSync(claudePath, 'utf-8');
    }

    if (fs.existsSync(copilotPath)) {
      copilotLogs = fs.readFileSync(copilotPath, 'utf-8');
    }

    return NextResponse.json({
      claudeLogs: claudeLogs.split('\n').filter(l => l.trim()),
      copilotLogs: copilotLogs.split('\n').filter(l => l.trim()),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}