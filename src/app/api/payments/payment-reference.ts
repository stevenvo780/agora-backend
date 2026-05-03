export type PaymentReference = {
  userId: string;
  planId: string;
};

export const parsePaymentExternalReference = (value: unknown): PaymentReference | null => {
  if (typeof value !== 'string') return null;

  const [rawUserId, rawPlanId] = value.split('|');
  const userId = rawUserId?.trim();
  const planId = rawPlanId?.trim();

  if (!userId || !planId) {
    return null;
  }

  return { userId, planId };
};
