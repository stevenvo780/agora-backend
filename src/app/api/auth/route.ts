import { NextResponse } from '@/lib/http/next-server';

export async function GET() {
  return NextResponse.json({ status: 'ok', msg: 'Auth API working' });
}
