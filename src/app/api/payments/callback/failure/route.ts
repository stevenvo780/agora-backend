import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { PaymentRedirectStatus } from '@/types/payments';
import { env } from '@/lib/env';

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const externalReference = searchParams.get('external_reference') || '';
  const planId = externalReference.split('|')[1] || '';

  const appUrl = env.APP_BASE_URL();
  const redirectUrl = new URL(`${appUrl}/dashboard`);
  redirectUrl.searchParams.set('payment', PaymentRedirectStatus.Failure);
  if (planId) redirectUrl.searchParams.set('plan', planId);

  return NextResponse.redirect(redirectUrl.toString());
}
